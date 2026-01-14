/**
 * Types for webview ↔ extension communication
 */

export interface GuildInfo {
  id: string;
  name: string;
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

export type ThreadCreationNotify = 'silent' | 'ping';
export type MessagePingMode = 'never' | 'discord_conversation' | 'always';

/** State sent from extension to webview */
export interface WebviewState {
  hasToken: boolean;
  connected: boolean;
  botUsername?: string;
  guildId?: string;
  guildName?: string;
  guilds: GuildInfo[];
  channels: ChannelInfo[];
  categories: CategoryInfo[];
  channelId?: string;
  channelName?: string;
  workspaceName: string;
  inviteUrl: string | null;
  logs: string[];
  threadInviteUserIds: string[];
  threadCreationNotify: ThreadCreationNotify;
  messagePingMode: MessagePingMode;
  implicitArchiveCount: number;
  implicitArchiveHours: number;
}

/** Messages from webview to extension */
export type WebviewToExtensionMessage =
  | { type: 'saveToken'; token: string }
  | { type: 'clearToken' }
  | { type: 'selectGuild'; guildId: string; guildName: string }
  | { type: 'createChannel'; channelName: string; categoryId?: string }
  | { type: 'selectChannel'; channelId: string; channelName: string }
  | { type: 'saveInviteUsers'; userIds: string }
  | { type: 'setThreadCreationNotify'; mode: ThreadCreationNotify }
  | { type: 'setMessagePingMode'; mode: MessagePingMode }
  | { type: 'setImplicitArchiveCount'; count: number }
  | { type: 'setImplicitArchiveHours'; hours: number }
  | { type: 'reconnect' }
  | { type: 'clearLogs' }
  | { type: 'refresh' }
  | { type: 'openUrl'; url: string };

/** Messages from extension to webview */
export type ExtensionToWebviewMessage =
  | { type: 'stateUpdate'; state: Partial<WebviewState> }
  | { type: 'logsUpdate'; logs: string[] };

/** VS Code API type */
export interface VSCodeAPI {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}

declare global {
  function acquireVsCodeApi(): VSCodeAPI;
}
