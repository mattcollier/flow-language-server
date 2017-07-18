/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import type {FlowOptions} from './types';
import type {VersionInfo} from './flow-versions/types';

import nuclideUri from 'nuclide-commons/nuclideUri';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {IConnection} from 'vscode-languageserver';

import Completion from './Completion';
import Definition from './Definition';
import Diagnostics from './Diagnostics';
import Hover from './Hover';
import SymbolSupport from './Symbol';
import TextDocuments from './TextDocuments';
import {FlowExecInfoContainer} from './pkg/nuclide-flow-rpc/lib/FlowExecInfoContainer';
import {FlowSingleProjectLanguageService} from './pkg/nuclide-flow-rpc/lib/FlowSingleProjectLanguageService';
import {getLogger} from 'log4js';
import {ServerStatus} from './pkg/nuclide-flow-rpc/lib/FlowConstants';
import {flowBinForPath} from './flow-versions/flowBinForRoot';
import {downloadSemverFromGitHub} from './flow-versions/githubSemverDownloader';
import {versionInfoForPath} from './flow-versions/utils';

export function createServer(connection: IConnection, initialFlowOptions: FlowOptions) {
  const logger = getLogger('index');
  const disposable = new UniversalDisposable();
  const documents = new TextDocuments();

  disposable.add(documents);

  connection.onShutdown(() => {
    logger.debug('LSP server connection shutting down');
    disposable.dispose();
  });

  connection.onInitialize(async ({capabilities, rootPath}) => {
    const root = rootPath || process.cwd();

    logger.debug('LSP connection initialized. Connecting to flow...');

    const flowVersionInfo = await getFlowVersionInfo(rootPath, connection, initialFlowOptions);
    if (!flowVersionInfo) {
      return {capabilities: {}};
    }
    const flowContainer = new FlowExecInfoContainer(flowVersionInfo);
    const flow = new FlowSingleProjectLanguageService(root, flowContainer);

    disposable.add(
      flow,
      flow.getServerStatusUpdates().distinctUntilChanged().subscribe(statusType => {
        connection.console.info(`Flow status: ${statusType}`);
      }),
    );

    const diagnostics = new Diagnostics({connection, flow});
    disposable.add(diagnostics);
    diagnostics.observe();

    const completion = new Completion({
      clientCapabilities: capabilities,
      documents,
      flow,
    });
    connection.onCompletion(docParams => {
      logger.debug(`completion requested for document ${docParams.textDocument.uri}`);
      return completion.provideCompletionItems(docParams);
    });

    connection.onCompletionResolve(() => {
      // for now, noop as we can't/don't need to provide any additional
      // information on resolve, but need to respond to implement completion
    });

    const definition = new Definition({connection, documents, flow});
    connection.onDefinition(docParams => {
      logger.debug(`definition requested for document ${docParams.textDocument.uri}`);
      return definition.provideDefinition(docParams);
    });

    const hover = new Hover({connection, documents, flow});
    connection.onHover(docParams => {
      return hover.provideHover(docParams);
    });

    const symbols = new SymbolSupport({connection, documents, flow});
    connection.onDocumentSymbol(symbolParams => {
      logger.debug(`symbols requested for document ${symbolParams.textDocument.uri}`);
      return symbols.provideDocumentSymbol(symbolParams);
    });

    logger.info('Flow language server started');

    return {
      capabilities: {
        textDocumentSync: documents.syncKind,
        definitionProvider: true,
        documentSymbolProvider: true,
        completionProvider: {
          resolveProvider: true,
        },
        hoverProvider: true,
      },
    };
  });

  return {
    listen() {
      documents.listen(connection);
      connection.listen();
    },
  };
}

async function getFlowVersionInfo(
  rootPath: string,
  connection: IConnection,
  flowOptions: FlowOptions,
): Promise<?VersionInfo> {
  const versionLogger = getLogger('flow-versions');

  if (flowOptions.pathToFlow != null) {
    connection.window.showInformationMessage('path to flow ' + flowOptions.pathToFlow);
    if (!nuclideUri.isAbsolute(flowOptions.pathToFlow)) {
      connection.window.showErrorMessage(
        'Supplied path to flow was not absolute. Specify a complete path to ' +
          'the flow binary or leave the option empty for Flow to be managed ' +
          'for you.',
      );
      return;
    }

    const flowVersionInfo = await versionInfoForPath(rootPath, flowOptions.pathToFlow);
    if (!flowVersionInfo) {
      connection.window.showErrorMessage('Invalid path to flow binary.');
    }
    versionLogger.info(`Using the provided path to flow binary at ${flowOptions.pathToFlow}`);

    return flowVersionInfo;
  }

  const downloadManagerLogger = {
    error: connection.window.showErrorMessage.bind(connection.window),
    info: versionLogger.info.bind(versionLogger),
    warn: versionLogger.warn.bind(versionLogger),
  };

  const versionInfo = await flowBinForPath(rootPath, {
    autoDownloadFlow: flowOptions.autoDownloadFlow,
    reporter: downloadManagerLogger,
    semverDownloader: downloadSemverFromGitHub,
    tryFlowBin: flowOptions.tryFlowBin,
  });

  if (!versionInfo) {
    versionLogger.error(
      'There was a problem obtaining the appropriate version of flow for ' +
        'your project. Please check the extension logs.',
    );
  }

  return versionInfo;
}