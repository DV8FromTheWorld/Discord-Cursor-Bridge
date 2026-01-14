/**
 * Status bar management.
 * Runs in the UI part (local) to show connection status.
 */

import * as vscode from 'vscode';
import { ConnectionStatus } from '../shared/types';

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private currentStatus: ConnectionStatus = 'disconnected';

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'discordBridge.showPanel';
    this.setStatus('disconnected');
    this.statusBarItem.show();
  }

  setStatus(status: ConnectionStatus, details?: string): void {
    this.currentStatus = status;

    switch (status) {
      case 'disconnected':
        this.statusBarItem.text = '$(circle-slash) Discord';
        this.statusBarItem.tooltip = 'Discord Bridge: Disconnected\nClick to open settings';
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'connecting':
        this.statusBarItem.text = '$(sync~spin) Discord';
        this.statusBarItem.tooltip = 'Discord Bridge: Connecting...';
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'connected':
        this.statusBarItem.text = '$(check) Discord';
        this.statusBarItem.tooltip = `Discord Bridge: Connected${details ? `\n${details}` : ''}\nClick to open settings`;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'error':
        this.statusBarItem.text = '$(error) Discord';
        this.statusBarItem.tooltip = `Discord Bridge: Error${details ? `\n${details}` : ''}\nClick to open settings`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;

      case 'setup-required':
        // Use warning icon (not spinning) - setup needed, not actively connecting
        this.statusBarItem.text = '$(warning) Discord';
        this.statusBarItem.tooltip = 'Discord Bridge: Setup Required\nClick to configure';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
    }
  }

  getStatus(): ConnectionStatus {
    return this.currentStatus;
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
