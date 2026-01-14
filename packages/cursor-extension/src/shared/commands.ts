/**
 * Command definitions for UI ↔ Workspace communication.
 * These commands work across the VS Code Remote boundary.
 */

export const Commands = {
  // ============ Public Commands ============
  SHOW_PANEL: 'discordBridge.showPanel',
  RECONNECT: 'discordBridge.reconnect',
  START_WATCHER: 'discordBridge.startWatcher',
  STOP_WATCHER: 'discordBridge.stopWatcher',
  SHOW_STATUS: 'discordBridge.showStatus',
  RESYNC_THREAD_NAME: 'discordBridge.resyncThreadName',

  // ============ Internal: UI → Workspace ============
  // These are called by the UI part and handled by the Workspace part
  
  /** Post a message to a Discord thread */
  POST_TO_THREAD: 'discordBridge.internal.postToThread',
  
  /** Send a file/image to a Discord thread */
  SEND_FILE_TO_THREAD: 'discordBridge.internal.sendFileToThread',
  
  /** Start typing indicator in a thread */
  START_TYPING: 'discordBridge.internal.startTyping',
  
  /** Stop typing indicator in a thread */
  STOP_TYPING: 'discordBridge.internal.stopTyping',
  
  /** Create a new Discord thread for a chat */
  CREATE_THREAD: 'discordBridge.internal.createThread',
  
  /** Rename an existing Discord thread */
  RENAME_THREAD: 'discordBridge.internal.renameThread',
  
  /** Archive/close a Discord thread (not delete) */
  ARCHIVE_THREAD: 'discordBridge.internal.archiveThread',
  
  /** Forward a user prompt from Cursor to Discord */
  FORWARD_USER_PROMPT: 'discordBridge.internal.forwardUserPrompt',
  
  /** Get Discord connection status */
  GET_DISCORD_STATUS: 'discordBridge.internal.getDiscordStatus',
  
  /** Get guilds the bot is in */
  GET_GUILDS: 'discordBridge.internal.getGuilds',
  
  /** Create a channel for the project */
  CREATE_PROJECT_CHANNEL: 'discordBridge.internal.createProjectChannel',

  /** Get text channels in a guild */
  GET_CHANNELS: 'discordBridge.internal.getChannels',

  /** Get channel categories in a guild */
  GET_CATEGORIES: 'discordBridge.internal.getCategories',

  /** Select a channel for the project (updates currentChannel in discord client) */
  SELECT_CHANNEL: 'discordBridge.internal.selectChannel',

  /** Check bot permissions in a guild */
  CHECK_GUILD_PERMISSIONS: 'discordBridge.internal.checkGuildPermissions',

  /** Get bot invite URL */
  GET_BOT_INVITE_URL: 'discordBridge.internal.getBotInviteUrl',

  /** Get thread ID for the currently active chat */
  GET_THREAD_FOR_ACTIVE_CHAT: 'discordBridge.internal.getThreadForActiveChat',

  /** Resolve thread ID with fallback logic (by chatId, then latest unclaimed, with retry) */
  RESOLVE_THREAD_ID: 'discordBridge.internal.resolveThreadId',

  /** Ask a question in Discord and wait for user response */
  ASK_QUESTION: 'discordBridge.internal.askQuestion',

  // ============ Internal: Workspace → UI ============
  // These are called by the Workspace part and handled by the UI part
  
  /** Send a message to a Cursor chat (triggers key simulation) */
  SEND_TO_CHAT: 'discordBridge.internal.sendToChat',
  
  /** Get configuration (token, guild, channel) */
  GET_CONFIG: 'discordBridge.internal.getConfig',
  
  /** Save configuration */
  SAVE_CONFIG: 'discordBridge.internal.saveConfig',
  
  /** Update status bar */
  UPDATE_STATUS: 'discordBridge.internal.updateStatus',
  
  /** Add log entry */
  ADD_LOG: 'discordBridge.internal.addLog',
};

// ============ Command Parameter Types ============

export interface PostToThreadParams {
  threadId?: string;
  message: string;
  asEmbed?: boolean;
}

export interface PostToThreadResult {
  success: boolean;
  threadId?: string;
  error?: string;
}

export interface SendFileToThreadParams {
  threadId?: string;
  filePath: string;
  fileName?: string;
  description?: string;
}

export interface SendFileToThreadResult {
  success: boolean;
  threadId?: string;
  error?: string;
}

export interface StartTypingParams {
  threadId?: string;
}

export interface StartTypingResult {
  success: boolean;
  error?: string;
}

export interface StopTypingParams {
  threadId?: string;
}

export interface StopTypingResult {
  success: boolean;
}

export interface CreateThreadParams {
  chatId: string;
  workspaceName: string;
  /** Optional human-readable name/description for the thread */
  name?: string;
}

export interface CreateThreadResult {
  success: boolean;
  threadId?: string;
  threadName?: string;
  error?: string;
  permissionError?: boolean;
}

export interface RenameThreadParams {
  threadId?: string;
  name: string;
}

export interface RenameThreadResult {
  success: boolean;
  oldName?: string;
  newName?: string;
  error?: string;
}

export interface ArchiveThreadParams {
  threadId?: string;
  /** If provided, look up threadId from this chatId */
  chatId?: string;
}

export interface ArchiveThreadResult {
  success: boolean;
  threadId?: string;
  error?: string;
}

export interface ForwardUserPromptParams {
  threadId: string;
  prompt: string;
}

export interface ForwardUserPromptResult {
  success: boolean;
  threadId?: string;
  error?: string;
}

export interface SendToChatParams {
  chatId: string;
  message: string;
  threadId?: string;
}

export interface SendToChatResult {
  success: boolean;
  error?: string;
}

import { ThreadCreationNotify, MessagePingMode } from './types';

export interface GetConfigResult {
  token?: string;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  /** User IDs to auto-invite when creating new threads */
  threadInviteUserIds?: string[];
  /** How to notify users when threads are created */
  threadCreationNotify?: ThreadCreationNotify;
  /** When to ping users on AI message responses */
  messagePingMode?: MessagePingMode;
  /** Number of top recent chats to keep Discord threads active for */
  implicitArchiveCount?: number;
  /** Hours since last activity before allowing Discord auto-archive */
  implicitArchiveHours?: number;
}

export interface SaveConfigParams {
  token?: string;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
}

export interface DiscordStatusResult {
  connected: boolean;
  botUsername?: string;
  guildCount?: number;
  error?: string;
}

export interface GuildInfo {
  id: string;
  name: string;
}

export interface CreateChannelParams {
  guildId: string;
  channelName: string;
  categoryId?: string;
}

export interface CreateChannelResult {
  success: boolean;
  channelId?: string;
  channelName?: string;
  error?: string;
  permissionError?: boolean;
}

export interface ChannelInfo {
  id: string;
  name: string;
  categoryId?: string;
  categoryName?: string;
}

export interface CategoryInfo {
  id: string;
  name: string;
}

export interface GetChannelsParams {
  guildId: string;
}

export interface GetCategoriesParams {
  guildId: string;
}

export interface SelectChannelParams {
  channelId: string;
  channelName: string;
}

export interface PermissionCheckResult {
  hasPermissions: boolean;
  missing: string[];
  inviteUrl?: string;
}

export interface CheckGuildPermissionsParams {
  guildId: string;
}

export interface GetThreadForActiveChatResult {
  success: boolean;
  threadId?: string;
  chatId?: string;
  error?: string;
}

/** How the thread ID was resolved */
export type ThreadResolutionMethod = 'latest_unclaimed' | 'waited_for_new';

export interface ResolveThreadIdResult {
  success: boolean;
  threadId?: string;
  chatId?: string;
  /** How the thread ID was resolved */
  method?: ThreadResolutionMethod;
  error?: string;
}

export type StatusUpdate = {
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'setup-required';
  details?: string;
};

// ============ Ask Question Types ============

/** An option for a question */
export interface AskQuestionOption {
  /** Unique identifier for this option */
  id: string;
  /** Display label for this option */
  label: string;
}

export interface AskQuestionParams {
  /** The thread to post the question in */
  threadId: string;
  /** The question text to display */
  question: string;
  /** Available options for the user to select */
  options: AskQuestionOption[];
  /** Allow selecting multiple options (default: false) */
  allowMultiple?: boolean;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
}

export interface AskQuestionResult {
  success: boolean;
  /** Type of response received */
  responseType?: 'option' | 'text';
  /** Selected option IDs (if responseType is 'option') */
  selectedOptionIds?: string[];
  /** Text response (if responseType is 'text') */
  textResponse?: string;
  error?: string;
}
