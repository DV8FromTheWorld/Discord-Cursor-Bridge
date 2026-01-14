/**
 * Shared types used by both UI and Workspace parts of the extension.
 */

export interface ProjectConfig {
  channelId: string;
  channelName?: string;
  createdAt: string;
}

/** How to notify users when a new thread is created */
export type ThreadCreationNotify = 'silent' | 'ping';

/** When to ping users on AI responses */
export type MessagePingMode = 'never' | 'discord_conversation' | 'always';

export interface GlobalConfig {
  guildId: string;
  guildName?: string;
  /** User IDs to auto-invite when creating new threads */
  threadInviteUserIds?: string[];
  /** How to notify users when threads are created (default: silent) */
  threadCreationNotify?: ThreadCreationNotify;
  /** When to ping users on AI message responses (default: never) */
  messagePingMode?: MessagePingMode;
  /** Number of top recent chats to keep Discord threads active for (default: 10) */
  implicitArchiveCount?: number;
  /** Hours since last activity before allowing Discord auto-archive (default: 48) */
  implicitArchiveHours?: number;
}

export interface ChatMapping {
  chatId: string;
  threadId: string;
  workspaceName: string;
  createdAt: string;
  /** Timestamp when this mapping was claimed by get_my_thread_id */
  claimedAt?: string;
}

export interface ThreadInfo {
  id: string;
  name: string;
  channelId: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'setup-required';
