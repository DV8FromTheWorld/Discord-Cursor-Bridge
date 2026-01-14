import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectConfig, GlobalConfig, ChatMapping, ThreadCreationNotify, MessagePingMode } from '../shared/types';

/**
 * Manages configuration storage for the Discord bridge.
 * Runs in the UI part (local) to access secure storage and local files.
 */
export class ConfigManager {
  private context: vscode.ExtensionContext;
  private outputChannel: vscode.OutputChannel;

  constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
    this.context = context;
    this.outputChannel = outputChannel;
  }

  // ============ Bot Token (Secure, Global) ============

  async getBotToken(): Promise<string | undefined> {
    return this.context.secrets.get('discordBridge.botToken');
  }

  async setBotToken(token: string): Promise<void> {
    await this.context.secrets.store('discordBridge.botToken', token);
    this.outputChannel.appendLine('Bot token saved securely');
  }

  async clearBotToken(): Promise<void> {
    await this.context.secrets.delete('discordBridge.botToken');
    this.outputChannel.appendLine('Bot token cleared');
  }

  async hasBotToken(): Promise<boolean> {
    const token = await this.getBotToken();
    return !!token && token.length > 0;
  }

  // ============ Guild Configuration (Global) ============

  getGlobalConfig(): GlobalConfig | undefined {
    return this.context.globalState.get<GlobalConfig>('discordBridge.globalConfig');
  }

  async setGlobalConfig(config: GlobalConfig): Promise<void> {
    await this.context.globalState.update('discordBridge.globalConfig', config);
    this.outputChannel.appendLine(`Global config saved: guild ${config.guildId}`);
  }

  async clearGlobalConfig(): Promise<void> {
    await this.context.globalState.update('discordBridge.globalConfig', undefined);
  }

  hasGuildConfigured(): boolean {
    const config = this.getGlobalConfig();
    return !!config?.guildId;
  }

  // ============ Thread Invite User IDs ============

  getThreadInviteUserIds(): string[] {
    const config = this.getGlobalConfig();
    return config?.threadInviteUserIds || [];
  }

  async setThreadInviteUserIds(userIds: string[]): Promise<void> {
    const config = this.getGlobalConfig();
    if (!config) {
      this.outputChannel.appendLine('Cannot set invite user IDs: no global config');
      return;
    }
    await this.setGlobalConfig({
      ...config,
      threadInviteUserIds: userIds,
    });
    this.outputChannel.appendLine(`Thread invite user IDs saved: ${userIds.length} user(s)`);
  }

  // ============ Notification Settings ============

  getThreadCreationNotify(): ThreadCreationNotify {
    const config = this.getGlobalConfig();
    return config?.threadCreationNotify || 'silent';
  }

  async setThreadCreationNotify(mode: ThreadCreationNotify): Promise<void> {
    const config = this.getGlobalConfig();
    if (!config) {
      this.outputChannel.appendLine('Cannot set thread creation notify: no global config');
      return;
    }
    await this.setGlobalConfig({
      ...config,
      threadCreationNotify: mode,
    });
    this.outputChannel.appendLine(`Thread creation notify set to: ${mode}`);
  }

  getMessagePingMode(): MessagePingMode {
    const config = this.getGlobalConfig();
    return config?.messagePingMode || 'never';
  }

  async setMessagePingMode(mode: MessagePingMode): Promise<void> {
    const config = this.getGlobalConfig();
    if (!config) {
      this.outputChannel.appendLine('Cannot set message ping mode: no global config');
      return;
    }
    await this.setGlobalConfig({
      ...config,
      messagePingMode: mode,
    });
    this.outputChannel.appendLine(`Message ping mode set to: ${mode}`);
  }

  // ============ Implicit Archive Settings ============

  getImplicitArchiveCount(): number {
    const config = this.getGlobalConfig();
    return config?.implicitArchiveCount ?? 10;
  }

  async setImplicitArchiveCount(count: number): Promise<void> {
    const config = this.getGlobalConfig();
    if (!config) {
      this.outputChannel.appendLine('Cannot set implicit archive count: no global config');
      return;
    }
    await this.setGlobalConfig({
      ...config,
      implicitArchiveCount: count,
    });
    this.outputChannel.appendLine(`Implicit archive count set to: ${count}`);
  }

  getImplicitArchiveHours(): number {
    const config = this.getGlobalConfig();
    return config?.implicitArchiveHours ?? 48;
  }

  async setImplicitArchiveHours(hours: number): Promise<void> {
    const config = this.getGlobalConfig();
    if (!config) {
      this.outputChannel.appendLine('Cannot set implicit archive hours: no global config');
      return;
    }
    await this.setGlobalConfig({
      ...config,
      implicitArchiveHours: hours,
    });
    this.outputChannel.appendLine(`Implicit archive hours set to: ${hours}`);
  }

  // ============ Project Configuration (Per-Workspace) ============

  getProjectConfig(): ProjectConfig | undefined {
    return this.context.workspaceState.get<ProjectConfig>('discordBridge.projectConfig');
  }

  async setProjectConfig(config: ProjectConfig): Promise<void> {
    await this.context.workspaceState.update('discordBridge.projectConfig', config);
    this.outputChannel.appendLine(`Project config saved: channel ${config.channelId}`);
  }

  async clearProjectConfig(): Promise<void> {
    await this.context.workspaceState.update('discordBridge.projectConfig', undefined);
  }

  hasProjectConfigured(): boolean {
    const config = this.getProjectConfig();
    return !!config?.channelId;
  }

  // ============ Chat Mappings (Per-Workspace) ============

  getChatMappings(): Map<string, ChatMapping> {
    const data = this.context.workspaceState.get<[string, ChatMapping][]>('discordBridge.chatMappings', []);
    return new Map(data);
  }

  async setChatMapping(mapping: ChatMapping): Promise<void> {
    const mappings = this.getChatMappings();
    mappings.set(mapping.chatId, mapping);
    await this.context.workspaceState.update('discordBridge.chatMappings', [...mappings.entries()]);
  }

  async removeChatMapping(chatId: string): Promise<void> {
    const mappings = this.getChatMappings();
    mappings.delete(chatId);
    await this.context.workspaceState.update('discordBridge.chatMappings', [...mappings.entries()]);
  }

  getThreadForChat(chatId: string): string | undefined {
    return this.getChatMappings().get(chatId)?.threadId;
  }

  getChatForThread(threadId: string): string | undefined {
    for (const [chatId, mapping] of this.getChatMappings()) {
      if (mapping.threadId === threadId) {
        return chatId;
      }
    }
    return undefined;
  }

  // ============ MCP Configuration ============

  /**
   * Ensures the MCP server is configured in ~/.cursor/mcp.json
   * Returns true if a restart is needed
   */
  async ensureMcpConfigured(): Promise<boolean> {
    const mcpServerPath = path.join(this.context.extensionPath, 'out', 'mcp', 'server.js');
    const mcpConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');

    // Check if MCP server file exists
    if (!fs.existsSync(mcpServerPath)) {
      this.outputChannel.appendLine(`MCP server not found at ${mcpServerPath}`);
      return false;
    }

    // Read existing config
    let config: { mcpServers?: Record<string, any> } = { mcpServers: {} };
    try {
      if (fs.existsSync(mcpConfigPath)) {
        config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      }
    } catch (e) {
      this.outputChannel.appendLine(`Failed to read mcp.json: ${e}`);
    }

    config.mcpServers = config.mcpServers || {};

    // Check if already configured with correct path
    const existing = config.mcpServers['discord-bridge'];
    if (existing?.args?.[0] === mcpServerPath) {
      this.outputChannel.appendLine('MCP already configured correctly');
      return false;
    }

    // Update config
    config.mcpServers['discord-bridge'] = {
      command: 'node',
      args: [mcpServerPath],
    };

    // Write config
    try {
      fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
      fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
      this.outputChannel.appendLine(`MCP configured at ${mcpConfigPath}`);
      return true; // Restart needed
    } catch (e) {
      this.outputChannel.appendLine(`Failed to write mcp.json: ${e}`);
      return false;
    }
  }

  // ============ Full Config Access ============

  async getFullConfig(): Promise<{
    token: string | undefined;
    global: GlobalConfig | undefined;
    project: ProjectConfig | undefined;
  }> {
    return {
      token: await this.getBotToken(),
      global: this.getGlobalConfig(),
      project: this.getProjectConfig(),
    };
  }

  async isFullyConfigured(): Promise<boolean> {
    const hasToken = await this.hasBotToken();
    const hasGuild = this.hasGuildConfigured();
    return hasToken && hasGuild;
  }
}
