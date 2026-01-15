/**
 * Webview panel for settings and logs.
 * Runs in the UI part (local) to display the settings interface.
 * Uses a React-based webview for better state management and UX.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from './configManager';
import { Commands, GuildInfo, DiscordStatusResult, ChannelInfo, CategoryInfo, PermissionCheckResult } from '../shared/commands';
import { ThreadCreationNotify, MessagePingMode } from '../shared/types';

/** State sent from extension to webview */
interface WebviewState {
  hasToken: boolean;
  connected: boolean;
  botUsername: string | null;
  guildId: string | null;
  guildName: string | null;
  guilds: GuildInfo[];
  channels: ChannelInfo[];
  categories: CategoryInfo[];
  channelId: string | null;
  channelName: string | null;
  workspaceName: string;
  inviteUrl: string | null;
  logs: string[];
  threadInviteUserIds: string[];
  threadCreationNotify: ThreadCreationNotify;
  messagePingMode: MessagePingMode;
  implicitArchiveCount: number;
  implicitArchiveHours: number;
}

export class WebviewPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private context: vscode.ExtensionContext;
  private configManager: ConfigManager;
  private outputChannel: vscode.OutputChannel;
  private logs: string[] = [];
  private maxLogs = 200;
  private currentState: WebviewState | null = null;

  constructor(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    outputChannel: vscode.OutputChannel
  ) {
    this.context = context;
    this.configManager = configManager;
    this.outputChannel = outputChannel;
  }

  addLog(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 23);
    const logEntry = `[${timestamp}] ${message}`;
    this.logs.push(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    // Send incremental log update to webview
    this.sendLogsUpdate();
  }

  clearLogs(): void {
    this.logs = [];
    this.sendLogsUpdate();
  }

  /**
   * Send only logs update to webview (doesn't reset other state)
   */
  private sendLogsUpdate(): void {
    if (this.panel) {
      this.panel.webview.postMessage({
        type: 'logsUpdate',
        logs: this.logs,
      });
    }
  }

  /**
   * Send full state update to webview
   */
  private sendStateUpdate(state: Partial<WebviewState>): void {
    if (this.panel) {
      this.panel.webview.postMessage({
        type: 'stateUpdate',
        state,
      });
    }
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'discordBridgeSettings',
      'Discord Bridge Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, 'webview-ui', 'dist')),
        ],
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      await this.handleMessage(msg);
    });

    // Set the initial HTML with React app
    this.panel.webview.html = this.getHtml();

    // Send initial state
    await this.refreshState();
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'saveToken':
        await this.configManager.setBotToken(msg.token);
        this.addLog('Bot token saved');
        vscode.commands.executeCommand(Commands.RECONNECT);
        await this.refreshState();
        break;

      case 'selectGuild':
        await this.handleSelectGuild(msg.guildId, msg.guildName);
        break;

      case 'createChannel':
        await this.createProjectChannel(msg.channelName, msg.categoryId);
        await this.refreshState();
        break;

      case 'clearToken':
        await this.clearAllSettings();
        await this.refreshState();
        break;

      case 'selectChannel':
        await this.handleSelectChannel(msg.channelId, msg.channelName);
        await this.refreshState();
        break;

      case 'saveInviteUsers':
        await this.handleSaveInviteUsers(msg.userIds);
        await this.refreshState();
        break;

      case 'setThreadCreationNotify':
        await this.configManager.setThreadCreationNotify(msg.mode);
        this.addLog(`Thread creation notify set to: ${msg.mode}`);
        await this.refreshState();
        break;

      case 'setMessagePingMode':
        await this.configManager.setMessagePingMode(msg.mode);
        this.addLog(`Message ping mode set to: ${msg.mode}`);
        await this.refreshState();
        break;

      case 'setImplicitArchiveCount':
        await this.configManager.setImplicitArchiveCount(msg.count);
        this.addLog(`Implicit archive count set to: ${msg.count}`);
        await this.refreshState();
        break;

      case 'setImplicitArchiveHours':
        await this.configManager.setImplicitArchiveHours(msg.hours);
        this.addLog(`Implicit archive hours set to: ${msg.hours}`);
        await this.refreshState();
        break;

      case 'reconnect':
        this.addLog('Reconnecting to Discord...');
        vscode.commands.executeCommand(Commands.RECONNECT);
        break;

      case 'clearLogs':
        this.clearLogs();
        break;

      case 'refresh':
        this.addLog('Refreshing...');
        await this.refreshState();
        break;

      case 'openUrl':
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
    }
  }

  private async handleSelectGuild(guildId: string, guildName: string): Promise<void> {
    const permissions = await vscode.commands.executeCommand<PermissionCheckResult>(
      Commands.CHECK_GUILD_PERMISSIONS,
      { guildId }
    );

    if (!permissions?.hasPermissions) {
      const missing = permissions?.missing?.join(', ') || 'Unknown';
      this.addLog(`Missing permissions in ${guildName}: ${missing}`);
      
      const action = await vscode.window.showWarningMessage(
        `Bot is missing permissions in "${guildName}": ${missing}`,
        'Reinstall Bot',
        'Continue Anyway'
      );

      if (action === 'Reinstall Bot' && permissions?.inviteUrl) {
        vscode.env.openExternal(vscode.Uri.parse(permissions.inviteUrl));
        return;
      } else if (action !== 'Continue Anyway') {
        return;
      }
    }

    await this.configManager.setGlobalConfig({
      guildId,
      guildName,
    });
    await this.configManager.clearProjectConfig();
    this.addLog(`Guild selected: ${guildName}`);
    await this.refreshState();
  }

  private async handleSelectChannel(channelId: string, channelName: string): Promise<void> {
    if (!channelId) {
      await this.configManager.clearProjectConfig();
      // Also notify workspace part to clear channel and update status
      await vscode.commands.executeCommand(Commands.SELECT_CHANNEL, { channelId: '', channelName: '' });
      this.addLog('Channel cleared');
      return;
    }
    
    await this.configManager.setProjectConfig({
      channelId,
      channelName,
      createdAt: new Date().toISOString(),
    });
    
    const success = await vscode.commands.executeCommand<boolean>(
      Commands.SELECT_CHANNEL,
      { channelId, channelName }
    );
    
    if (success) {
      this.addLog(`Channel selected: #${channelName}`);
    } else {
      this.addLog(`Warning: Saved channel config but failed to connect to #${channelName}`);
    }
  }

  private async handleSaveInviteUsers(userIdsInput: string): Promise<void> {
    const userIds = userIdsInput
      .split(/[,\n]/)
      .map((id: string) => id.trim())
      .filter((id: string) => id.length > 0);
    
    await this.configManager.setThreadInviteUserIds(userIds);
    this.addLog(`Thread invite users saved: ${userIds.length} user(s)`);
  }

  private async createProjectChannel(channelName: string, categoryId?: string): Promise<void> {
    const global = this.configManager.getGlobalConfig();
    if (!global?.guildId) {
      vscode.window.showErrorMessage('No guild configured');
      return;
    }

    try {
      const result = await vscode.commands.executeCommand<{ 
        success: boolean; 
        channelId?: string; 
        channelName?: string; 
        error?: string;
        permissionError?: boolean;
      }>(
        Commands.CREATE_PROJECT_CHANNEL,
        { guildId: global.guildId, channelName, categoryId: categoryId || undefined }
      );

      if (result?.success && result.channelId) {
        await this.configManager.setProjectConfig({
          channelId: result.channelId,
          channelName: result.channelName,
          createdAt: new Date().toISOString(),
        });
        this.addLog(`Channel created: #${result.channelName}`);
      } else {
        this.addLog(`Failed to create channel: ${result?.error}`);
        
        if (result?.permissionError) {
          const inviteUrl = await vscode.commands.executeCommand<string>(Commands.GET_BOT_INVITE_URL);
          const action = await vscode.window.showErrorMessage(
            `Failed to create channel: ${result.error}`,
            'Reinstall Bot'
          );
          if (action === 'Reinstall Bot' && inviteUrl) {
            vscode.env.openExternal(vscode.Uri.parse(inviteUrl));
          }
        } else {
          vscode.window.showErrorMessage(`Failed to create channel: ${result?.error}`);
        }
      }
    } catch (error: any) {
      this.addLog(`Error creating channel: ${error.message}`);
      vscode.window.showErrorMessage(`Error: ${error.message}`);
    }
  }

  /**
   * Refresh and send the full state to the webview
   */
  private async refreshState(): Promise<void> {
    if (!this.panel) return;

    const hasToken = await this.configManager.hasBotToken();
    const global = this.configManager.getGlobalConfig();
    const project = this.configManager.getProjectConfig();

    let status: DiscordStatusResult = { connected: false };
    let guilds: GuildInfo[] = [];
    let channels: ChannelInfo[] = [];
    let categories: CategoryInfo[] = [];
    let inviteUrl: string | null = null;

    try {
      status = await vscode.commands.executeCommand<DiscordStatusResult>(Commands.GET_DISCORD_STATUS) || { connected: false };
      
      if (hasToken && status.connected) {
        guilds = await vscode.commands.executeCommand<GuildInfo[]>(Commands.GET_GUILDS) || [];
        inviteUrl = await vscode.commands.executeCommand<string>(Commands.GET_BOT_INVITE_URL);
        
        if (global?.guildId) {
          channels = await vscode.commands.executeCommand<ChannelInfo[]>(
            Commands.GET_CHANNELS,
            { guildId: global.guildId }
          ) || [];
          categories = await vscode.commands.executeCommand<CategoryInfo[]>(
            Commands.GET_CATEGORIES,
            { guildId: global.guildId }
          ) || [];
        }
      }
    } catch {
      // Workspace part might not be available yet
    }

    const state: WebviewState = {
      hasToken,
      connected: status.connected,
      botUsername: status.botUsername ?? null,
      guildId: global?.guildId ?? null,
      guildName: global?.guildName ?? null,
      guilds,
      channels,
      categories,
      channelId: project?.channelId ?? null,
      channelName: project?.channelName ?? null,
      workspaceName: vscode.workspace.name || 'unnamed',
      inviteUrl,
      logs: this.logs,
      threadInviteUserIds: global?.threadInviteUserIds || [],
      threadCreationNotify: global?.threadCreationNotify || 'silent',
      messagePingMode: global?.messagePingMode || 'never',
      implicitArchiveCount: global?.implicitArchiveCount ?? 10,
      implicitArchiveHours: global?.implicitArchiveHours ?? 48,
    };

    this.currentState = state;
    this.sendStateUpdate(state);
  }

  private async clearAllSettings(): Promise<void> {
    await this.configManager.clearBotToken();
    await this.configManager.clearGlobalConfig();
    await this.configManager.clearProjectConfig();
    this.addLog('All settings cleared');
    vscode.commands.executeCommand(Commands.RECONNECT);
  }

  private getHtml(): string {
    if (!this.panel) return '';

    const webview = this.panel.webview;
    
    // Get paths to the bundled React app
    const scriptPath = vscode.Uri.file(
      path.join(this.context.extensionPath, 'webview-ui', 'dist', 'webview.js')
    );
    const scriptUri = webview.asWebviewUri(scriptPath);

    // Check if the bundled file exists
    const scriptExists = fs.existsSync(scriptPath.fsPath);
    if (!scriptExists) {
      return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Discord Bridge Settings</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    .error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 12px;
      border-radius: 4px;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <h2>Discord Bridge Settings</h2>
  <div class="error">
    <strong>Build Required</strong><br><br>
    The webview UI has not been built yet. Run:<br><br>
    <code>cd packages/cursor-extension && npm run build:webview</code><br><br>
    Then reload the window.
  </div>
</body>
</html>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';">
  <title>Discord Bridge Settings</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
