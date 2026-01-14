import { VSCodeAPI, WebviewToExtensionMessage } from './types';

// Acquire the VS Code API once and export it
let vscodeApi: VSCodeAPI | undefined;

export function getVSCodeAPI(): VSCodeAPI {
  if (!vscodeApi) {
    vscodeApi = acquireVsCodeApi();
  }
  return vscodeApi;
}

export function postMessage(message: WebviewToExtensionMessage): void {
  getVSCodeAPI().postMessage(message);
}
