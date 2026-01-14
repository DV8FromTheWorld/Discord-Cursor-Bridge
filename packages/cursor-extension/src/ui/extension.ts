/**
 * UI Extension entry point.
 * Runs on the local machine and handles:
 * - HTTP server for MCP communication
 * - Key simulation for auto-submit
 * - Configuration management (token storage, MCP config)
 * - Status bar and webview panel
 */

import * as vscode from 'vscode';
import { ConfigManager } from './configManager';
import { HttpServer } from './httpServer';
import { StatusBarManager } from './statusBar';
import { WebviewPanelManager } from './webviewPanel';
import { sendMessageToChat } from './messageHandler';
import { checkKeySimulationAvailable } from './keySimulation';
import { Commands, SendToChatParams, GetConfigResult, SaveConfigParams, StatusUpdate } from '../shared/commands';
import { ConnectionStatus } from '../shared/types';

let configManager: ConfigManager;
let httpServer: HttpServer;
let statusBar: StatusBarManager;
let webviewPanel: WebviewPanelManager;
let outputChannel: vscode.OutputChannel;

export async function activateUI(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Discord Bridge');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Discord Bridge UI extension activating...');

  // Initialize managers
  configManager = new ConfigManager(context, outputChannel);
  statusBar = new StatusBarManager();
  webviewPanel = new WebviewPanelManager(context, configManager, outputChannel);
  httpServer = new HttpServer(19876, outputChannel, configManager);

  context.subscriptions.push({ dispose: () => statusBar.dispose() });
  context.subscriptions.push({ dispose: () => webviewPanel.dispose() });
  context.subscriptions.push({ dispose: () => httpServer.stop() });

  // Register UI commands
  registerUICommands(context);

  // Check key simulation availability
  const keyCheck = await checkKeySimulationAvailable();
  if (!keyCheck.available) {
    outputChannel.appendLine(`Warning: Key simulation not available: ${keyCheck.error}`);
  } else {
    outputChannel.appendLine('Key simulation available');
  }

  // Check if setup is needed
  const hasToken = await configManager.hasBotToken();
  const hasGuild = configManager.hasGuildConfigured();
  
  if (!hasToken) {
    statusBar.setStatus('setup-required');
    outputChannel.appendLine('Setup required: missing bot token');
    
    // Show toast notification for first-time setup
    const action = await vscode.window.showInformationMessage(
      'Discord Bridge needs to be configured. Set up your Discord bot token to get started.',
      'Open Settings'
    );
    if (action === 'Open Settings') {
      webviewPanel.show();
    }
  } else if (!hasGuild) {
    statusBar.setStatus('setup-required');
    outputChannel.appendLine('Setup required: missing guild configuration');
  } else {
    statusBar.setStatus('disconnected');
  }

  // Configure MCP
  const needsRestart = await configManager.ensureMcpConfigured();
  if (needsRestart) {
    const action = await vscode.window.showInformationMessage(
      'Discord Bridge MCP configured. Restart Cursor to enable AI tools.',
      'Restart Now',
      'Later'
    );
    if (action === 'Restart Now') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  // Start HTTP server
  try {
    await httpServer.start();
    outputChannel.appendLine('HTTP server started for MCP communication');
  } catch (error: any) {
    outputChannel.appendLine(`Failed to start HTTP server: ${error.message}`);
  }

  outputChannel.appendLine('Discord Bridge UI extension activated');
}

function registerUICommands(context: vscode.ExtensionContext): void {
  // Public commands
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.SHOW_PANEL, () => {
      webviewPanel.show();
    })
  );

  // Internal: Workspace → UI commands
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.SEND_TO_CHAT, async (params: SendToChatParams) => {
      const { chatId, message, threadId } = params;

      if (!chatId) {
        return { success: false, error: 'chatId is required' };
      }

      return sendMessageToChat(chatId, message, outputChannel, {
        threadId,
        prependDirective: true,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.GET_CONFIG, async (): Promise<GetConfigResult> => {
      const token = await configManager.getBotToken();
      const global = configManager.getGlobalConfig();
      const project = configManager.getProjectConfig();

      return {
        token,
        guildId: global?.guildId,
        guildName: global?.guildName,
        channelId: project?.channelId,
        channelName: project?.channelName,
        threadInviteUserIds: global?.threadInviteUserIds,
        threadCreationNotify: global?.threadCreationNotify,
        messagePingMode: global?.messagePingMode,
        implicitArchiveCount: global?.implicitArchiveCount ?? 10,
        implicitArchiveHours: global?.implicitArchiveHours ?? 48,
      };
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.SAVE_CONFIG, async (params: SaveConfigParams) => {
      if (params.token !== undefined) {
        await configManager.setBotToken(params.token);
      }
      if (params.guildId !== undefined) {
        await configManager.setGlobalConfig({
          guildId: params.guildId,
          guildName: params.guildName,
        });
      }
      if (params.channelId !== undefined) {
        await configManager.setProjectConfig({
          channelId: params.channelId,
          channelName: params.channelName,
          createdAt: new Date().toISOString(),
        });
      }
      return { success: true };
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.UPDATE_STATUS, (status: StatusUpdate) => {
      statusBar.setStatus(status.status as ConnectionStatus, status.details);
      webviewPanel.addLog(`Status: ${status.status}${status.details ? ` - ${status.details}` : ''}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.ADD_LOG, (message: string) => {
      webviewPanel.addLog(message);
    })
  );
}

export function deactivateUI(): void {
  outputChannel?.appendLine('Discord Bridge UI extension deactivating...');
  httpServer?.stop();
}
