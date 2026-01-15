/**
 * Main Extension Entry Point
 *
 * This extension uses a split UI/Workspace architecture to support remote development.
 *
 * UI Part (runs locally):
 * - HTTP server for MCP communication
 * - Key simulation for auto-submit
 * - Configuration management
 * - Status bar and settings panel
 *
 * Workspace Part (runs locally or remotely):
 * - Discord bot connection
 * - Chat watching and thread creation
 * - Message forwarding
 *
 * Communication between parts uses VS Code commands, which work transparently
 * across the local/remote boundary.
 */

import * as vscode from 'vscode';
import { activateUI, deactivateUI } from './ui/extension';
import { activateWorkspace, deactivateWorkspace } from './workspace/extension';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Discord Bridge (Main)');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('Discord Bridge activating...');
  outputChannel.appendLine(`UI Kind: ${vscode.UIKind[vscode.env.uiKind]}`);
  outputChannel.appendLine(`Remote Name: ${vscode.env.remoteName || 'none'}`);

  // Detect execution context
  const isUIExtension = vscode.env.uiKind === vscode.UIKind.Desktop;
  const isRemote = vscode.env.remoteName !== undefined;

  outputChannel.appendLine(`Is UI Extension: ${isUIExtension}, Is Remote: ${isRemote}`);

  // Always activate UI part on local machine
  // In remote, the UI part runs locally and workspace part runs remotely
  if (isUIExtension || !isRemote) {
    outputChannel.appendLine('Activating UI part...');
    try {
      await activateUI(context);
      outputChannel.appendLine('UI part activated');
    } catch (error: any) {
      outputChannel.appendLine(`UI activation error: ${error.message}`);
    }
  }

  // Always activate workspace part (it handles the Discord connection)
  outputChannel.appendLine('Activating Workspace part...');
  try {
    await activateWorkspace(context);
    outputChannel.appendLine('Workspace part activated');
  } catch (error: any) {
    outputChannel.appendLine(`Workspace activation error: ${error.message}`);
  }

  outputChannel.appendLine('Discord Bridge activation complete');
}

export function deactivate(): void {
  deactivateUI();
  deactivateWorkspace();
}
