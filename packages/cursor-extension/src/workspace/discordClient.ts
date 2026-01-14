/**
 * Discord client for the Workspace part.
 * Runs on the remote machine (or locally if not remote) and handles Discord API interactions.
 * Communicates with the UI part via VS Code commands for sending messages to Cursor.
 */

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  ThreadChannel,
  ChannelType,
  Events,
  Message,
  Guild,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  SectionBuilder,
  TextDisplayBuilder,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  Interaction,
  ComponentType,
} from 'discord.js';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Commands, GetConfigResult, PostToThreadParams, CreateThreadParams, CreateThreadResult, PostToThreadResult, CreateChannelParams, CreateChannelResult, DiscordStatusResult, GuildInfo, ChannelInfo, CategoryInfo, PermissionCheckResult, CheckGuildPermissionsParams, GetChannelsParams, GetCategoriesParams, SendFileToThreadParams, SendFileToThreadResult, StartTypingParams, StartTypingResult, StopTypingParams, StopTypingResult, RenameThreadParams, RenameThreadResult, ArchiveThreadParams, ArchiveThreadResult, ForwardUserPromptParams, ForwardUserPromptResult, AskQuestionParams, AskQuestionResult, AskQuestionOption } from '../shared/commands';
import { ChatMapping } from '../shared/types';
import { getChatName } from './cursorStorage';

// Required permissions for the bot
const REQUIRED_PERMISSIONS = [
  { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
  { flag: PermissionFlagsBits.CreatePublicThreads, name: 'Create Public Threads' },
  { flag: PermissionFlagsBits.SendMessagesInThreads, name: 'Send Messages in Threads' },
  { flag: PermissionFlagsBits.ManageChannels, name: 'Manage Channels' },
  { flag: PermissionFlagsBits.ViewChannel, name: 'View Channels' },
  { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
  { flag: PermissionFlagsBits.AddReactions, name: 'Add Reactions' },
];

const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export interface DiscordClientEvents {
  onReady: () => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
  onThreadMessage: (threadId: string, message: string, author: string) => void;
}

// Typing timeout - auto-stop after 5 minutes to prevent stuck indicators
const TYPING_TIMEOUT_MS = 5 * 60 * 1000;

// Default timeout for ask_question - 5 minutes
const ASK_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

// Buffer for detecting manual vs auto archive (5 minutes)
const ARCHIVE_DETECTION_BUFFER_MS = 5 * 60 * 1000;

interface TypingState {
  interval: NodeJS.Timeout;
  timeout: NodeJS.Timeout;
}

/** Tracks a pending question awaiting user response */
interface PendingQuestion {
  threadId: string;
  messageId: string;
  question: string; // Original question text
  options: AskQuestionOption[];
  allowMultiple: boolean;
  selectedOptions: Set<string>; // For multi-select tracking
  resolve: (result: AskQuestionResult) => void;
  timeout: NodeJS.Timeout;
}

export class DiscordClientManager {
  private client: Client | null = null;
  private outputChannel: vscode.OutputChannel;
  private context: vscode.ExtensionContext;
  private events: DiscordClientEvents;
  private isConnected: boolean = false;
  private currentChannel: TextChannel | null = null;
  private typingState: Map<string, TypingState> = new Map();
  /** Tracks threads with recent Discord user messages (for discord_conversation ping mode) */
  private activeDiscordConversations: Map<string, { userId: string; timestamp: number }> = new Map();
  /** Tracks pending questions awaiting user response (keyed by messageId) */
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  /** Tracks last activity time for each thread (for detecting manual vs auto archive) */
  private threadLastActivity: Map<string, number> = new Map();
  /** Tracks threads explicitly archived by Discord user (won't auto-reopen) */
  private explicitlyArchivedThreadIds: Set<string> = new Set();

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    events: DiscordClientEvents
  ) {
    this.context = context;
    this.outputChannel = outputChannel;
    this.events = events;
    
    // Load persisted data
    this.loadThreadLastActivity();
    this.loadExplicitlyArchivedThreadIds();
  }

  async connect(): Promise<void> {
    // Get token from UI part
    const config = await vscode.commands.executeCommand<GetConfigResult>(Commands.GET_CONFIG);
    if (!config?.token) {
      throw new Error('No bot token configured');
    }

    if (this.client) {
      await this.disconnect();
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('Client not initialized'));
        return;
      }

      this.client.once(Events.ClientReady, async (readyClient) => {
        this.isConnected = true;
        this.outputChannel.appendLine(`Discord bot ready: ${readyClient.user.tag}`);

        // Notify UI part of status update
        vscode.commands.executeCommand(Commands.UPDATE_STATUS, {
          status: 'connected',
          details: `Connected as ${readyClient.user.tag}`,
        });

        // Try to connect to the configured channel
        await this.connectToConfiguredChannel();

        this.events.onReady();
        resolve();
      });

      this.client.on(Events.Error, (error) => {
        this.outputChannel.appendLine(`Discord error: ${error.message}`);
        vscode.commands.executeCommand(Commands.UPDATE_STATUS, {
          status: 'error',
          details: error.message,
        });
        this.events.onError(error);
      });

      this.client.on(Events.MessageCreate, async (message) => {
        await this.handleMessage(message);
      });

      this.client.on(Events.InteractionCreate, async (interaction) => {
        await this.handleInteraction(interaction);
      });

      this.client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
        await this.handleThreadUpdate(oldThread, newThread);
      });

      this.client.login(config.token).catch((error) => {
        this.outputChannel.appendLine(`Discord login failed: ${error.message}`);
        vscode.commands.executeCommand(Commands.UPDATE_STATUS, {
          status: 'error',
          details: `Login failed: ${error.message}`,
        });
        reject(error);
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      // Stop all typing indicators
      this.stopAllTyping();
      
      this.client.destroy();
      this.client = null;
      this.isConnected = false;
      this.currentChannel = null;
      vscode.commands.executeCommand(Commands.UPDATE_STATUS, {
        status: 'disconnected',
      });
      this.events.onDisconnect();
      this.outputChannel.appendLine('Discord disconnected');
    }
  }

  isReady(): boolean {
    return this.isConnected && this.client !== null;
  }

  getStatus(): DiscordStatusResult {
    if (!this.isConnected || !this.client?.user) {
      return { connected: false };
    }
    return {
      connected: true,
      botUsername: this.client.user.username,
      guildCount: this.client.guilds.cache.size,
    };
  }

  getBotInfo(): { id: string; username: string } | null {
    if (!this.client?.user) return null;
    return {
      id: this.client.user.id,
      username: this.client.user.username,
    };
  }

  // ============ Guild Operations ============

  async getGuilds(): Promise<GuildInfo[]> {
    if (!this.client) return [];

    const guilds: GuildInfo[] = [];
    for (const [id, guild] of this.client.guilds.cache) {
      guilds.push({ id, name: guild.name });
    }
    return guilds;
  }

  async getGuild(guildId: string): Promise<Guild | null> {
    if (!this.client) return null;
    try {
      return await this.client.guilds.fetch(guildId);
    } catch {
      return null;
    }
  }

  // ============ Permission Checking ============

  async checkGuildPermissions(params: CheckGuildPermissionsParams): Promise<PermissionCheckResult> {
    const guild = await this.getGuild(params.guildId);
    if (!guild) {
      return {
        hasPermissions: false,
        missing: ['Bot not in server'],
        inviteUrl: this.getBotInviteUrl() || undefined,
      };
    }

    const me = guild.members.me;
    if (!me) {
      return {
        hasPermissions: false,
        missing: ['Cannot fetch bot member'],
        inviteUrl: this.getBotInviteUrl() || undefined,
      };
    }

    const missing: string[] = [];
    for (const { flag, name } of REQUIRED_PERMISSIONS) {
      if (!me.permissions.has(flag)) {
        missing.push(name);
      }
    }

    return {
      hasPermissions: missing.length === 0,
      missing,
      inviteUrl: missing.length > 0 ? this.getBotInviteUrl() || undefined : undefined,
    };
  }

  // ============ Channel Operations ============

  async getChannels(params: GetChannelsParams): Promise<ChannelInfo[]> {
    const guild = await this.getGuild(params.guildId);
    if (!guild) return [];

    const channels: ChannelInfo[] = [];
    for (const [id, channel] of guild.channels.cache) {
      if (channel.type === ChannelType.GuildText) {
        const parent = channel.parent;
        channels.push({ 
          id, 
          name: channel.name,
          categoryId: parent?.id,
          categoryName: parent?.name,
        });
      }
    }
    return channels.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getCategories(params: GetCategoriesParams): Promise<CategoryInfo[]> {
    const guild = await this.getGuild(params.guildId);
    if (!guild) return [];

    const categories: CategoryInfo[] = [];
    for (const [id, channel] of guild.channels.cache) {
      if (channel.type === ChannelType.GuildCategory) {
        categories.push({ id, name: channel.name });
      }
    }
    return categories.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProjectChannel(params: CreateChannelParams): Promise<CreateChannelResult> {
    const guild = await this.getGuild(params.guildId);
    if (!guild) {
      return { success: false, error: `Guild ${params.guildId} not found` };
    }

    try {
      // Sanitize channel name (Discord rules: lowercase, no spaces, max 100 chars)
      const channelName = params.channelName
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-')
        .replace(/-+/g, '-')
        .substring(0, 100);

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `Cursor agent conversations`,
        parent: params.categoryId || undefined,
      });

      this.outputChannel.appendLine(`Created channel #${channel.name} in ${guild.name}`);
      this.currentChannel = channel;

      return {
        success: true,
        channelId: channel.id,
        channelName: channel.name,
      };
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to create channel: ${error.message}`);
      // Check if it's a permission error
      const isPermissionError = error.code === 50013 || error.message?.includes('Missing Permissions');
      return { 
        success: false, 
        error: isPermissionError 
          ? 'Missing permissions to create channels. Please re-invite the bot with the correct permissions.'
          : error.message,
        permissionError: isPermissionError,
      };
    }
  }

  async selectChannel(channelId: string): Promise<boolean> {
    if (!this.client) return false;
    
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel instanceof TextChannel) {
        this.currentChannel = channel;
        this.outputChannel.appendLine(`Selected channel #${channel.name}`);
        return true;
      }
      return false;
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to select channel: ${error.message}`);
      return false;
    }
  }

  private async connectToConfiguredChannel(): Promise<void> {
    const config = await vscode.commands.executeCommand<GetConfigResult>(Commands.GET_CONFIG);
    if (!config?.channelId || !this.client) return;

    try {
      const channel = await this.client.channels.fetch(config.channelId);
      if (channel instanceof TextChannel) {
        this.currentChannel = channel;
        this.outputChannel.appendLine(`Connected to channel #${channel.name}`);
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to fetch configured channel: ${error.message}`);
    }
  }

  // ============ Thread Operations ============

  async createThread(params: CreateThreadParams): Promise<CreateThreadResult> {
    if (!this.currentChannel) {
      return { success: false, error: 'No channel connected' };
    }

    // Check if we already have a thread for this chat
    const existingMapping = this.getChatMapping(params.chatId);
    if (existingMapping) {
      // Try to fetch the actual thread name from Discord
      try {
        const thread = await this.currentChannel.threads.fetch(existingMapping.threadId);
        if (thread) {
          return {
            success: true,
            threadId: existingMapping.threadId,
            threadName: thread.name,
          };
        }
      } catch {
        // Thread may have been deleted, fall through to create a new one
      }
    }

    try {
      // Generate thread name from provided name
      const threadName = this.generateThreadName(params.name);
      
      if (!threadName) {
        return { 
          success: false, 
          error: 'No thread name provided. A name is required to create a thread.' 
        };
      }

      // Create the thread directly without a starter message
      const thread = await this.currentChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080, // 7 days
        type: ChannelType.PublicThread,
      });

      // Store the mapping
      await this.setChatMapping({
        chatId: params.chatId,
        threadId: thread.id,
        workspaceName: params.workspaceName,
        createdAt: new Date().toISOString(),
      });

      // Track initial activity for this thread
      await this.updateThreadActivity(thread.id);

      // Auto-invite configured users to the thread
      await this.inviteUsersToThread(thread);

      // Send initial message
      await thread.send(
        `🤖 **New Agent Session**\n\nWorkspace: ${params.workspaceName}\n\nThis thread is connected to Cursor agent \`${params.chatId}\`.\nMessages you send here will be forwarded to the agent.`
      );

      this.outputChannel.appendLine(`Created thread "${threadName}" for chat ${params.chatId}`);

      return {
        success: true,
        threadId: thread.id,
        threadName,
      };
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to create thread: ${error.message}`);
      const isPermissionError = error.code === 50013 || error.message?.includes('Missing Permissions');
      return { 
        success: false, 
        error: isPermissionError 
          ? 'Missing permissions to create threads. Please re-invite the bot with the correct permissions.'
          : error.message,
        permissionError: isPermissionError,
      };
    }
  }

  /**
   * Generate a human-readable thread name.
   * Discord thread names are limited to 100 characters.
   * 
   * The workspace is NOT included - the parent channel already identifies it.
   * If no name is provided, returns undefined (caller should prompt user).
   */
  private generateThreadName(name?: string): string | undefined {
    const MAX_LENGTH = 100;
    
    if (name) {
      // Use the name directly, truncated if needed
      return name.substring(0, MAX_LENGTH);
    }

    // No name provided - return undefined so caller can handle it
    return undefined;
  }

  /**
   * Rename an existing Discord thread.
   */
  async renameThread(params: RenameThreadParams): Promise<RenameThreadResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected' };
    }

    if (!params.threadId) {
      return { success: false, error: 'No thread ID provided' };
    }
    const threadId = params.threadId;

    try {
      // Fetch thread directly via client (works for threads in any channel)
      const channel = await this.client.channels.fetch(threadId);
      if (!(channel instanceof ThreadChannel)) {
        return { success: false, error: `Thread ${threadId} not found or not a thread` };
      }

      const oldName = channel.name;
      const newName = params.name.substring(0, 100); // Discord thread name limit
      
      // Skip if name is already correct
      if (oldName === newName) {
        this.outputChannel.appendLine(`Thread "${oldName}" already has correct name, skipping`);
        return { success: true, oldName, newName };
      }

      await channel.setName(newName);
      this.outputChannel.appendLine(`Renamed thread "${oldName}" → "${newName}"`);

      return {
        success: true,
        oldName,
        newName,
      };
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to rename thread: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Archive/close a Discord thread (does not delete it).
   * This is useful when the corresponding Cursor chat is archived.
   */
  async archiveThread(params: ArchiveThreadParams): Promise<ArchiveThreadResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected' };
    }

    // Determine thread ID - either directly provided or look up from chatId
    let threadId = params.threadId;
    if (!threadId && params.chatId) {
      const mapping = this.getChatMapping(params.chatId);
      if (mapping) {
        threadId = mapping.threadId;
      } else {
        return { success: false, error: `No thread mapping found for chat ${params.chatId}` };
      }
    }

    if (!threadId) {
      return { success: false, error: 'No thread ID provided' };
    }

    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!(thread instanceof ThreadChannel)) {
        return { success: false, error: `Thread ${threadId} not found` };
      }

      // Archive the thread (this closes it without deleting)
      await thread.setArchived(true);
      this.outputChannel.appendLine(`Archived thread "${thread.name}" (${threadId})`);

      return { success: true, threadId };
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to archive thread: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Unarchive/reopen a Discord thread.
   * This is useful when the corresponding Cursor chat is unarchived.
   */
  async unarchiveThread(params: ArchiveThreadParams): Promise<ArchiveThreadResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected' };
    }

    // Determine thread ID - either directly provided or look up from chatId
    let threadId = params.threadId;
    if (!threadId && params.chatId) {
      const mapping = this.getChatMapping(params.chatId);
      if (mapping) {
        threadId = mapping.threadId;
      } else {
        return { success: false, error: `No thread mapping found for chat ${params.chatId}` };
      }
    }

    if (!threadId) {
      return { success: false, error: 'No thread ID provided' };
    }

    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!(thread instanceof ThreadChannel)) {
        return { success: false, error: `Thread ${threadId} not found` };
      }

      // Unarchive the thread (reopen it)
      await thread.setArchived(false);
      this.outputChannel.appendLine(`Unarchived thread "${thread.name}" (${threadId})`);

      return { success: true, threadId };
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to unarchive thread: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if a Discord thread is archived.
   * Returns true if archived, false if not, or undefined if thread couldn't be fetched.
   */
  async isThreadArchived(chatId: string): Promise<boolean | undefined> {
    if (!this.client) {
      return undefined;
    }

    const mapping = this.getChatMapping(chatId);
    if (!mapping) {
      return undefined;
    }

    try {
      const thread = await this.client.channels.fetch(mapping.threadId);
      if (!(thread instanceof ThreadChannel)) {
        return undefined;
      }
      return thread.archived ?? false;
    } catch {
      return undefined;
    }
  }

  /**
   * Ensure threads for active (non-archived) Cursor chats are not archived on Discord.
   * Discord has auto-archive that can close threads after inactivity.
   * This reopens any threads that Discord auto-archived but Cursor still has active.
   * 
   * @param activeChatIds - Set of Cursor chat IDs that are NOT archived
   * @returns Number of threads that were reopened
   */
  async ensureActiveThreadsOpen(activeChatIds: Set<string>): Promise<number> {
    if (!this.client) {
      return 0;
    }

    let reopenedCount = 0;

    for (const chatId of activeChatIds) {
      const mapping = this.getChatMapping(chatId);
      if (!mapping) {
        continue; // No thread for this chat
      }

      // Skip threads that were explicitly archived by user
      if (this.isExplicitlyArchived(mapping.threadId)) {
        continue;
      }

      try {
        const thread = await this.client.channels.fetch(mapping.threadId);
        if (!(thread instanceof ThreadChannel)) {
          continue;
        }

        if (thread.archived) {
          // Thread was auto-archived by Discord but Cursor chat is still active
          this.outputChannel.appendLine(`[DISCORD AUTO-ARCHIVED] Reopening thread for chat ${chatId}`);
          await thread.setArchived(false);
          reopenedCount++;
        }
      } catch (error: any) {
        // Thread may have been deleted or bot lost access - ignore
        this.outputChannel.appendLine(`[ensureActiveThreadsOpen] Could not check thread for ${chatId}: ${error.message}`);
      }
    }

    return reopenedCount;
  }

  /**
   * Resync the thread name for a given chat ID by reading from Cursor's storage.
   * Returns the new name if successful, or undefined if the name couldn't be found.
   */
  async resyncThreadName(chatId: string): Promise<{ success: boolean; newName?: string; error?: string }> {
    // Get the chat name from Cursor's storage
    const chatName = await getChatName(chatId, this.outputChannel);
    
    if (!chatName) {
      return { success: false, error: 'Could not find chat name in Cursor storage' };
    }

    // Get the thread ID for this chat
    const mapping = this.getChatMapping(chatId);
    if (!mapping) {
      return { success: false, error: `No thread mapping found for chat ${chatId}` };
    }

    // Rename the thread
    const result = await this.renameThread({
      threadId: mapping.threadId,
      name: chatName,
    });

    if (result.success) {
      return { success: true, newName: result.newName };
    } else {
      return { success: false, error: result.error };
    }
  }

  /**
   * Invites configured users to a thread.
   * Optionally pings them based on threadCreationNotify setting.
   * Failures are logged but don't fail the thread creation.
   */
  private async inviteUsersToThread(thread: ThreadChannel): Promise<void> {
    try {
      const config = await vscode.commands.executeCommand<GetConfigResult>(Commands.GET_CONFIG);
      const userIds = config?.threadInviteUserIds;
      
      if (!userIds || userIds.length === 0) {
        return;
      }

      const notifyMode = config?.threadCreationNotify || 'silent';
      this.outputChannel.appendLine(`Inviting ${userIds.length} user(s) to thread ${thread.name} (mode: ${notifyMode})`);

      // Add all users to the thread
      for (const userId of userIds) {
        try {
          await thread.members.add(userId);
          this.outputChannel.appendLine(`Added user ${userId} to thread`);
        } catch (error: any) {
          // Log but don't fail - user might not be in the server, etc.
          this.outputChannel.appendLine(`Failed to add user ${userId}: ${error.message}`);
        }
      }

      // If ping mode, send a message mentioning all users
      if (notifyMode === 'ping' && userIds.length > 0) {
        const mentions = userIds.map(id => `<@${id}>`).join(' ');
        try {
          await thread.send(`${mentions} New agent session started!`);
          this.outputChannel.appendLine(`Pinged users in thread`);
        } catch (error: any) {
          this.outputChannel.appendLine(`Failed to ping users: ${error.message}`);
        }
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to get invite config: ${error.message}`);
    }
  }

  async postToThread(params: PostToThreadParams): Promise<PostToThreadResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected' };
    }

    if (!params.threadId) {
      return { success: false, error: 'No thread ID provided' };
    }
    const threadId = params.threadId;

    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!(thread instanceof ThreadChannel)) {
        return { success: false, error: `Thread ${threadId} not found` };
      }

      // Determine if we should ping users
      const pingPrefix = await this.getPingPrefixForThread(threadId);

      const chunks = this.splitMessage(params.message);

      if (params.asEmbed && chunks.length === 1) {
        await thread.send({
          content: pingPrefix || undefined,
          embeds: [
            new EmbedBuilder()
              .setDescription(chunks[0])
              .setColor(0x5865f2)
              .setTimestamp(),
          ],
        });
      } else {
        for (let i = 0; i < chunks.length; i++) {
          const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
          // Only add ping prefix to the first message
          const ping = i === 0 && pingPrefix ? `${pingPrefix}\n` : '';
          await thread.send(ping + prefix + chunks[i]);
        }
      }

      // Track activity for this thread (keeps it fresh for auto-archive detection)
      await this.updateThreadActivity(threadId);

      // Clear the active conversation after responding (for discord_conversation mode)
      // This way we only ping once per Discord message, not for every AI response
      if (this.activeDiscordConversations.has(threadId)) {
        this.activeDiscordConversations.delete(threadId);
      }

      return { success: true, threadId };
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to post to thread: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Determines if users should be pinged for this message based on settings.
   * Returns a mention string or empty string.
   */
  private async getPingPrefixForThread(threadId: string): Promise<string> {
    try {
      const config = await vscode.commands.executeCommand<GetConfigResult>(Commands.GET_CONFIG);
      const pingMode = config?.messagePingMode || 'never';
      const userIds = config?.threadInviteUserIds || [];

      if (userIds.length === 0) {
        return '';
      }

      switch (pingMode) {
        case 'always':
          return userIds.map(id => `<@${id}>`).join(' ');

        case 'discord_conversation': {
          // Check if there's an active Discord conversation in this thread
          const activeConvo = this.activeDiscordConversations.get(threadId);
          if (activeConvo) {
            // Only ping the user who sent the Discord message
            return `<@${activeConvo.userId}>`;
          }
          return '';
        }

        case 'never':
        default:
          return '';
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to get ping config: ${error.message}`);
      return '';
    }
  }

  async forwardUserPrompt(params: ForwardUserPromptParams): Promise<ForwardUserPromptResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected' };
    }

    if (!params.threadId) {
      return { success: false, error: 'No thread ID provided' };
    }

    try {
      const thread = await this.client.channels.fetch(params.threadId);
      if (!(thread instanceof ThreadChannel)) {
        return { success: false, error: `Thread ${params.threadId} not found` };
      }

      // Format the user prompt with a distinctive style
      const formattedPrompt = `📝 **User prompt from Cursor:**\n\`\`\`\n${params.prompt}\n\`\`\``;

      await thread.send(formattedPrompt);
      this.outputChannel.appendLine(`Forwarded user prompt to thread ${params.threadId}`);

      return { success: true, threadId: params.threadId };
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to forward user prompt: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async sendFileToThread(params: SendFileToThreadParams): Promise<SendFileToThreadResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected' };
    }

    if (!params.threadId) {
      return { success: false, error: 'No thread ID provided' };
    }
    const threadId = params.threadId;

    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!(thread instanceof ThreadChannel)) {
        return { success: false, error: `Thread ${threadId} not found` };
      }

      // Check if file exists
      if (!fs.existsSync(params.filePath)) {
        return { success: false, error: `File not found: ${params.filePath}` };
      }

      // Create attachment
      const fileName = params.fileName || path.basename(params.filePath);
      const attachment = new AttachmentBuilder(params.filePath, { name: fileName });

      // Send with optional description
      await thread.send({
        content: params.description || undefined,
        files: [attachment],
      });

      this.outputChannel.appendLine(`Sent file ${fileName} to thread ${threadId}`);
      return { success: true, threadId };
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to send file to thread: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async startTyping(params: StartTypingParams): Promise<StartTypingResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected' };
    }

    if (!params.threadId) {
      return { success: false, error: 'No thread ID provided' };
    }
    const threadId = params.threadId;

    // Stop any existing typing for this thread
    this.stopTypingForThread(threadId);

    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!(thread instanceof ThreadChannel)) {
        return { success: false, error: `Thread ${threadId} not found` };
      }

      // Send typing immediately
      await thread.sendTyping();

      // Set up interval to keep typing (Discord typing indicator lasts ~10 seconds)
      const interval = setInterval(async () => {
        try {
          await thread.sendTyping();
        } catch (error: any) {
          this.outputChannel.appendLine(`Failed to refresh typing: ${error.message}`);
          this.stopTypingForThread(threadId);
        }
      }, 8000); // Refresh every 8 seconds to stay within the 10 second window

      // Set up timeout to auto-stop typing after 5 minutes (safety net)
      const timeout = setTimeout(() => {
        this.outputChannel.appendLine(`Typing auto-stopped after timeout for thread ${threadId}`);
        this.stopTypingForThread(threadId);
      }, TYPING_TIMEOUT_MS);

      this.typingState.set(threadId, { interval, timeout });
      this.outputChannel.appendLine(`Started typing indicator in thread ${threadId}`);
      return { success: true };
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to start typing: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async stopTyping(params: StopTypingParams): Promise<StopTypingResult> {
    if (params.threadId) {
      this.stopTypingForThread(params.threadId);
    }
    // Always return success - if no threadId, there's nothing to stop
    return { success: true };
  }

  private stopTypingForThread(threadId: string): void {
    const state = this.typingState.get(threadId);
    if (state) {
      clearInterval(state.interval);
      clearTimeout(state.timeout);
      this.typingState.delete(threadId);
      this.outputChannel.appendLine(`Stopped typing indicator in thread ${threadId}`);
    }
  }

  stopAllTyping(): void {
    for (const [threadId, state] of this.typingState) {
      clearInterval(state.interval);
      clearTimeout(state.timeout);
      this.outputChannel.appendLine(`Stopped typing indicator in thread ${threadId}`);
    }
    this.typingState.clear();
  }

  // ============ Message Handling ============

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    // Only process messages in threads
    if (!message.channel.isThread()) return;

    const thread = message.channel as ThreadChannel;

    // Check if this thread is mapped to a Cursor chat
    const mapping = this.getMappingForThread(thread.id);
    if (!mapping) {
      return; // Not a mapped thread
    }

    this.outputChannel.appendLine(
      `Message in thread ${thread.name}: ${message.content.substring(0, 50)}...`
    );

    // Track activity for this thread (for manual vs auto archive detection)
    await this.updateThreadActivity(thread.id);

    // Clear explicit archive flag if set (user sending a message means they want the thread active)
    await this.clearExplicitArchive(thread.id);

    // Check if this message is responding to a pending question
    if (this.checkForQuestionResponse(thread.id, message.content, message.author.id)) {
      this.outputChannel.appendLine(`Message resolved pending question in thread ${thread.name}`);
      await message.react('✅');
      return; // Don't forward to Cursor - this was an answer to a question
    }

    // Track this as an active Discord conversation for ping purposes
    this.activeDiscordConversations.set(thread.id, {
      userId: message.author.id,
      timestamp: Date.now(),
    });

    // Emit event for external handling
    this.events.onThreadMessage(thread.id, message.content, message.author.username);

    // Send message to Cursor via UI part command
    try {
      const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
        Commands.SEND_TO_CHAT,
        {
          chatId: mapping.chatId,
          message: message.content,
          threadId: thread.id,
        }
      );

      if (!result?.success) {
        this.outputChannel.appendLine(`Failed to send to Cursor: ${result?.error}`);
        await message.reply(`❌ Failed to send to Cursor: ${result?.error}`);
      } else {
        await message.react('✅');
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`Error sending to Cursor: ${error.message}`);
      await message.reply(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Handle thread update events to detect manual vs auto archive.
   */
  private async handleThreadUpdate(oldThread: ThreadChannel, newThread: ThreadChannel): Promise<void> {
    // Only care about archive status changes
    if (oldThread.archived === newThread.archived) return;

    // Check if this is one of our managed threads
    const mapping = this.getMappingForThread(newThread.id);
    if (!mapping) return;

    if (!oldThread.archived && newThread.archived) {
      // Thread was just archived
      await this.handleThreadArchived(newThread);
    } else if (oldThread.archived && !newThread.archived) {
      // Thread was just unarchived (e.g., user sent a message)
      await this.clearExplicitArchive(newThread.id);
      this.outputChannel.appendLine(`[ThreadUpdate] Thread unarchived: ${newThread.name}`);
    }
  }

  /**
   * Determine if a thread archive was manual (user action) or automatic (Discord inactivity).
   * Manual archives are marked as "explicitly archived" so auto-reopen won't revive them.
   */
  private async handleThreadArchived(thread: ThreadChannel): Promise<void> {
    const autoArchiveDurationMs = (thread.autoArchiveDuration || 1440) * 60 * 1000;
    const threshold = autoArchiveDurationMs - ARCHIVE_DETECTION_BUFFER_MS;
    
    // Get last activity time - prefer our tracked value, fall back to thread creation time
    const lastActivity = this.threadLastActivity.get(thread.id) ?? thread.createdTimestamp ?? Date.now();
    const timeSinceActivity = Date.now() - lastActivity;

    if (timeSinceActivity < threshold) {
      // Archived BEFORE Discord would auto-archive → manual archive
      this.outputChannel.appendLine(
        `[ThreadUpdate] Thread "${thread.name}" manually archived (${Math.round(timeSinceActivity / 60000)}min since activity, threshold ${Math.round(threshold / 60000)}min)`
      );
      await this.markExplicitlyArchived(thread.id);
    } else {
      // Archived AFTER enough inactivity → Discord auto-archive
      this.outputChannel.appendLine(
        `[ThreadUpdate] Thread "${thread.name}" auto-archived by Discord (${Math.round(timeSinceActivity / 60000)}min since activity)`
      );
      // Don't mark as explicit - auto-reopen can revive this
    }
  }

  /**
   * Handle button interactions for ask_question responses.
   */
  private async handleInteraction(interaction: Interaction): Promise<void> {
    // Only handle button interactions
    if (!interaction.isButton()) return;

    const customId = interaction.customId;
    
    // Check if this is for one of our pending questions
    // Custom IDs are formatted as: ask_q_{messageId}_{optionId} or ask_q_{messageId}_submit
    if (!customId.startsWith('ask_q_')) return;

    const parts = customId.split('_');
    if (parts.length < 4) return;

    const messageId = parts[2];
    const action = parts.slice(3).join('_'); // Option ID or 'submit'

    const pending = this.pendingQuestions.get(messageId);
    if (!pending) {
      // Question may have timed out or been answered
      await interaction.reply({ content: 'This question has expired or already been answered.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (pending.allowMultiple) {
      // Multi-select mode
      if (action === 'submit') {
        // User submitted their selection
        const selectedIds = Array.from(pending.selectedOptions);
        await this.resolveQuestion(pending, {
          success: true,
          responseType: 'option',
          selectedOptionIds: selectedIds,
        });
        await interaction.reply({ content: `Selection submitted: ${selectedIds.length} option(s) selected.`, flags: MessageFlags.Ephemeral });
      } else {
        // Toggle selection
        if (pending.selectedOptions.has(action)) {
          pending.selectedOptions.delete(action);
        } else {
          pending.selectedOptions.add(action);
        }
        // Update the message to show current selection
        await this.updateQuestionMessage(pending);
        await interaction.deferUpdate();
      }
    } else {
      // Single-select mode - resolve immediately
      // Track the selected option so disableQuestionButtons can show it
      pending.selectedOptions.add(action);
      await this.resolveQuestion(pending, {
        success: true,
        responseType: 'option',
        selectedOptionIds: [action],
      });
      await interaction.reply({ content: `You selected: ${pending.options.find(o => o.id === action)?.label || action}`, flags: MessageFlags.Ephemeral });
    }
  }

  /**
   * Resolve a pending question with the given result.
   */
  private async resolveQuestion(pending: PendingQuestion, result: AskQuestionResult): Promise<void> {
    // Clear timeout
    clearTimeout(pending.timeout);
    
    // Remove from pending
    this.pendingQuestions.delete(pending.messageId);
    
    // Update the message to show it's been answered
    await this.disableQuestionButtons(pending);
    
    // Resolve the promise
    pending.resolve(result);
  }

  /**
   * Update the question message to show current multi-select state.
   */
  private async updateQuestionMessage(pending: PendingQuestion): Promise<void> {
    if (!this.client) return;

    try {
      const thread = await this.client.channels.fetch(pending.threadId);
      if (!(thread instanceof ThreadChannel)) return;

      const message = await thread.messages.fetch(pending.messageId);
      if (!message) return;

      // Rebuild components with updated selection state
      const components = this.buildQuestionComponents(
        '', // Question text not needed for update
        pending.options,
        pending.allowMultiple,
        pending.selectedOptions,
        false // not disabled
      );

      await message.edit({ components });
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to update question message: ${error.message}`);
    }
  }

  /**
   * Replace question message with a list showing the answered state.
   * Shows ✅ for selected options and ▫️ for unselected options.
   */
  private async disableQuestionButtons(pending: PendingQuestion): Promise<void> {
    if (!this.client) return;

    try {
      const thread = await this.client.channels.fetch(pending.threadId);
      if (!(thread instanceof ThreadChannel)) return;

      const message = await thread.messages.fetch(pending.messageId);
      if (!message) return;

      // Build the answered question as a simple list
      const container = new ContainerBuilder();
      
      // Add question header
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**❓ ${pending.question}**`)
      );
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
      );

      // Add each option as a list item with ✅ or ▫️
      const optionLines = pending.options.map(option => {
        const isSelected = pending.selectedOptions.has(option.id);
        const marker = isSelected ? '✅' : '▫️';
        return `${marker} ${option.label}`;
      }).join('\n');
      
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(optionLines)
      );

      await message.edit({ components: [container] });
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to update answered question: ${error.message}`);
    }
  }

  /**
   * Build Components V2 message components for a question.
   */
  private buildQuestionComponents(
    questionText: string,
    options: AskQuestionOption[],
    allowMultiple: boolean,
    selectedOptions: Set<string>,
    disabled: boolean
  ): any[] {
    // Use a Container with Sections for each option
    const container = new ContainerBuilder();

    // Add question header if provided (for initial message)
    if (questionText) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**❓ ${questionText}**`)
      );
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
      );
    }

    // Add a section for each option
    for (const option of options) {
      const isSelected = selectedOptions.has(option.id);
      const buttonStyle = isSelected ? ButtonStyle.Success : ButtonStyle.Secondary;
      const buttonLabel = allowMultiple 
        ? (isSelected ? '✓ Selected' : 'Select')
        : 'Select';

      const section = new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(option.label)
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`ask_q_${options[0] ? '' : ''}`) // Placeholder, will be set properly below
            .setLabel(buttonLabel)
            .setStyle(buttonStyle)
            .setDisabled(disabled)
        );

      // Need to set custom ID properly - rebuild the button
      const button = new ButtonBuilder()
        .setCustomId(`ask_q_${this.currentQuestionMessageId}_${option.id}`)
        .setLabel(buttonLabel)
        .setStyle(buttonStyle)
        .setDisabled(disabled);

      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(option.label)
          )
          .setButtonAccessory(button)
      );
    }

    // Add submit button for multi-select
    if (allowMultiple && !disabled) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
      );
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('*Click Submit when ready*')
          )
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`ask_q_${this.currentQuestionMessageId}_submit`)
              .setLabel('Submit Selection')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(disabled || selectedOptions.size === 0)
          )
      );
    }

    // Add footer hint
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('_You can also reply with a message to provide a custom answer._')
    );

    return [container];
  }

  // Temporary storage for current question message ID during component building
  private currentQuestionMessageId: string = '';

  // ============ Ask Question ============

  /**
   * Ask a question in a Discord thread and wait for user response.
   * Supports both button selection and text message responses.
   */
  async askQuestion(params: AskQuestionParams): Promise<AskQuestionResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected' };
    }

    if (!params.threadId) {
      return { success: false, error: 'No thread ID provided' };
    }

    if (!params.options || params.options.length === 0) {
      return { success: false, error: 'No options provided' };
    }

    const threadId = params.threadId;
    const timeoutMs = params.timeoutMs || ASK_QUESTION_TIMEOUT_MS;

    try {
      const thread = await this.client.channels.fetch(threadId);
      if (!(thread instanceof ThreadChannel)) {
        return { success: false, error: `Thread ${threadId} not found` };
      }

      // Generate a unique message ID placeholder for component building
      const tempMessageId = `temp_${Date.now()}`;
      this.currentQuestionMessageId = tempMessageId;

      // Build the initial components
      const components = this.buildQuestionComponents(
        params.question,
        params.options,
        params.allowMultiple || false,
        new Set(),
        false
      );

      // Send the question message with Components V2
      const message = await thread.send({
        components,
        flags: MessageFlags.IsComponentsV2,
      });

      // Now update the components with the real message ID
      this.currentQuestionMessageId = message.id;
      const updatedComponents = this.buildQuestionComponents(
        params.question,
        params.options,
        params.allowMultiple || false,
        new Set(),
        false
      );
      await message.edit({ components: updatedComponents });

      // Create promise that will be resolved when user responds
      return new Promise<AskQuestionResult>((resolve) => {
        // Set up timeout
        const timeout = setTimeout(async () => {
          const pending = this.pendingQuestions.get(message.id);
          if (pending) {
            this.pendingQuestions.delete(message.id);
            await this.disableQuestionButtons(pending);
            resolve({
              success: false,
              error: 'Question timed out waiting for response',
            });
          }
        }, timeoutMs);

        // Store pending question
        const pending: PendingQuestion = {
          threadId,
          messageId: message.id,
          question: params.question,
          options: params.options,
          allowMultiple: params.allowMultiple || false,
          selectedOptions: new Set(),
          resolve,
          timeout,
        };
        this.pendingQuestions.set(message.id, pending);

        this.outputChannel.appendLine(`Posted question in thread ${threadId}, waiting for response (message: ${message.id})`);
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to ask question: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if a text message in a thread should resolve a pending question.
   * Called from handleMessage.
   */
  private checkForQuestionResponse(threadId: string, messageContent: string, authorId: string): boolean {
    // Find any pending question for this thread
    for (const [messageId, pending] of this.pendingQuestions) {
      if (pending.threadId === threadId) {
        // This text message is a response to the pending question
        this.resolveQuestion(pending, {
          success: true,
          responseType: 'text',
          textResponse: messageContent,
        });
        return true;
      }
    }
    return false;
  }

  // ============ Chat Mapping (stored in workspace state) ============

  getChatMappings(): Map<string, ChatMapping> {
    const data = this.context.workspaceState.get<[string, ChatMapping][]>('discordBridge.chatMappings', []);
    return new Map(data);
  }

  /**
   * Fetch actual thread names from Discord for all mapped chats.
   * Returns a map of chatId -> threadName (from Discord, not Cursor).
   * Used by NameSyncWatcher to detect out-of-sync thread names.
   */
  async getDiscordThreadNames(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    
    if (!this.client) {
      return result;
    }

    const mappings = this.getChatMappings();
    
    for (const [chatId, mapping] of mappings) {
      try {
        // Fetch thread directly via client (works for threads in any channel)
        const channel = await this.client.channels.fetch(mapping.threadId);
        if (channel instanceof ThreadChannel) {
          result.set(chatId, channel.name);
        }
      } catch (error: any) {
        // Thread may have been deleted or bot lost access
        this.outputChannel.appendLine(`[DiscordClient] Could not fetch thread ${mapping.threadId}: ${error.message}`);
      }
    }

    return result;
  }

  private async saveChatMappings(mappings: Map<string, ChatMapping>): Promise<void> {
    await this.context.workspaceState.update('discordBridge.chatMappings', [...mappings.entries()]);
  }

  // ============ Thread Activity Persistence ============

  private loadThreadLastActivity(): void {
    const data = this.context.workspaceState.get<[string, number][]>('discordBridge.threadLastActivity', []);
    this.threadLastActivity = new Map(data);
    this.outputChannel.appendLine(`[DiscordClient] Loaded ${this.threadLastActivity.size} thread activity records`);
  }

  private async saveThreadLastActivity(): Promise<void> {
    await this.context.workspaceState.update('discordBridge.threadLastActivity', [...this.threadLastActivity.entries()]);
  }

  private async updateThreadActivity(threadId: string): Promise<void> {
    this.threadLastActivity.set(threadId, Date.now());
    await this.saveThreadLastActivity();
  }

  // ============ Explicit Archive Persistence ============

  private loadExplicitlyArchivedThreadIds(): void {
    const data = this.context.workspaceState.get<string[]>('discordBridge.explicitlyArchivedThreadIds', []);
    this.explicitlyArchivedThreadIds = new Set(data);
    this.outputChannel.appendLine(`[DiscordClient] Loaded ${this.explicitlyArchivedThreadIds.size} explicitly archived threads`);
  }

  private async saveExplicitlyArchivedThreadIds(): Promise<void> {
    await this.context.workspaceState.update('discordBridge.explicitlyArchivedThreadIds', [...this.explicitlyArchivedThreadIds]);
  }

  private async markExplicitlyArchived(threadId: string): Promise<void> {
    this.explicitlyArchivedThreadIds.add(threadId);
    await this.saveExplicitlyArchivedThreadIds();
    this.outputChannel.appendLine(`[DiscordClient] Marked thread ${threadId} as explicitly archived`);
  }

  async clearExplicitArchive(threadId: string): Promise<void> {
    if (this.explicitlyArchivedThreadIds.has(threadId)) {
      this.explicitlyArchivedThreadIds.delete(threadId);
      await this.saveExplicitlyArchivedThreadIds();
      this.outputChannel.appendLine(`[DiscordClient] Cleared explicit archive for thread ${threadId}`);
    }
  }

  /** Clear explicit archive by chat ID (looks up the thread mapping) */
  async clearExplicitArchiveForChat(chatId: string): Promise<void> {
    const mapping = this.getChatMapping(chatId);
    if (mapping) {
      await this.clearExplicitArchive(mapping.threadId);
    }
  }

  isExplicitlyArchived(threadId: string): boolean {
    return this.explicitlyArchivedThreadIds.has(threadId);
  }

  private getChatMapping(chatId: string): ChatMapping | undefined {
    return this.getChatMappings().get(chatId);
  }

  private getMappingForThread(threadId: string): ChatMapping | undefined {
    for (const [, mapping] of this.getChatMappings()) {
      if (mapping.threadId === threadId) {
        return mapping;
      }
    }
    return undefined;
  }

  private async setChatMapping(mapping: ChatMapping): Promise<void> {
    const mappings = this.getChatMappings();
    mappings.set(mapping.chatId, mapping);
    await this.saveChatMappings(mappings);
  }

  /**
   * Get the most recently created mapping that hasn't been claimed yet.
   * Returns undefined if all mappings are claimed or no mappings exist.
   * 
   * @deprecated Use getRecentUnclaimedMapping() instead to avoid grabbing stale mappings
   */
  getLatestUnclaimedMapping(): ChatMapping | undefined {
    const mappings = this.getChatMappings();
    let latest: ChatMapping | undefined;
    let latestTime = 0;

    for (const [, mapping] of mappings) {
      // Skip claimed mappings
      if (mapping.claimedAt) {
        continue;
      }

      const createdTime = new Date(mapping.createdAt).getTime();
      if (createdTime > latestTime) {
        latestTime = createdTime;
        latest = mapping;
      }
    }

    return latest;
  }

  /**
   * Get the most recently created mapping that hasn't been claimed yet,
   * but ONLY if it was created within the freshness threshold.
   * This prevents grabbing stale orphaned mappings from previous sessions.
   * 
   * @param freshnessMs Maximum age in milliseconds for a mapping to be considered (default: 30 seconds)
   * @returns The recent unclaimed mapping, or undefined if none exist within threshold
   */
  getRecentUnclaimedMapping(freshnessMs: number = 30000): ChatMapping | undefined {
    const now = Date.now();
    const mappings = this.getChatMappings();
    let latest: ChatMapping | undefined;
    let latestTime = 0;

    for (const [, mapping] of mappings) {
      // Skip claimed mappings
      if (mapping.claimedAt) {
        continue;
      }

      const createdTime = new Date(mapping.createdAt).getTime();
      const age = now - createdTime;

      // Skip mappings older than freshness threshold
      if (age > freshnessMs) {
        this.outputChannel.appendLine(`[getRecentUnclaimedMapping] Skipping stale mapping ${mapping.chatId} (age: ${Math.round(age / 1000)}s)`);
        continue;
      }

      if (createdTime > latestTime) {
        latestTime = createdTime;
        latest = mapping;
      }
    }

    return latest;
  }

  /**
   * Mark a mapping as claimed (thread ID has been returned to an agent).
   */
  async markMappingClaimed(chatId: string): Promise<void> {
    const mappings = this.getChatMappings();
    const mapping = mappings.get(chatId);
    if (mapping && !mapping.claimedAt) {
      mapping.claimedAt = new Date().toISOString();
      mappings.set(chatId, mapping);
      await this.saveChatMappings(mappings);
      this.outputChannel.appendLine(`[DiscordClient] Marked mapping ${chatId} as claimed`);
    }
  }

  /**
   * Wait for a new unclaimed mapping to appear (e.g., when ChatWatcher creates one).
   * Only considers recent mappings (created within freshnessMs) to avoid grabbing stale ones.
   * 
   * @param maxWaitMs Maximum time to wait in milliseconds
   * @param pollIntervalMs How often to check for new mappings
   * @param freshnessMs Maximum age for a mapping to be considered (default: 30 seconds)
   * @returns The new mapping, or undefined if timeout
   */
  async waitForNewUnclaimedMapping(maxWaitMs: number = 5000, pollIntervalMs: number = 200, freshnessMs: number = 30000): Promise<ChatMapping | undefined> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
      const mapping = this.getRecentUnclaimedMapping(freshnessMs);
      if (mapping) {
        return mapping;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    
    return undefined;
  }

  // ============ Utility ============

  private splitMessage(content: string): string[] {
    if (content.length <= DISCORD_MAX_MESSAGE_LENGTH) {
      return [content];
    }

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= DISCORD_MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n', DISCORD_MAX_MESSAGE_LENGTH);
      if (splitIndex === -1 || splitIndex < DISCORD_MAX_MESSAGE_LENGTH / 2) {
        splitIndex = remaining.lastIndexOf(' ', DISCORD_MAX_MESSAGE_LENGTH);
      }
      if (splitIndex === -1 || splitIndex < DISCORD_MAX_MESSAGE_LENGTH / 2) {
        splitIndex = DISCORD_MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
  }

  getBotInviteUrl(): string | null {
    if (!this.client?.user) return null;
    const clientId = this.client.user.id;
    // Permissions: View Channels, Manage Channels, Send Messages, Read Message History,
    // Create Public/Private Threads, Send Messages in Threads, Manage Threads
    const permissions = 397284550672n;
    return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot`;
  }
}
