/**
 * Workspace Extension entry point.
 * Runs on the remote machine (or locally if not remote) and handles:
 * - Discord bot connection and messaging
 * - Chat watching and automatic thread creation
 * - Thread-to-chat message forwarding
 */

import * as vscode from 'vscode';
import { DiscordClientManager } from './discordClient';
import { ChatWatcher } from './chatWatcher';
import { NameSyncWatcher } from './nameSyncWatcher';
import { ensureCursorRulesExist } from './cursorRules';
import { Commands, PostToThreadParams, CreateThreadParams, CreateChannelParams, DiscordStatusResult, GuildInfo, ChannelInfo, CategoryInfo, PermissionCheckResult, CheckGuildPermissionsParams, GetChannelsParams, GetCategoriesParams, SelectChannelParams, SendFileToThreadParams, StartTypingParams, StopTypingParams, RenameThreadParams, ArchiveThreadParams, GetThreadForActiveChatResult, ResolveThreadIdResult, ForwardUserPromptParams, AskQuestionParams, AskQuestionResult } from '../shared/commands';

let discordClient: DiscordClientManager;
let chatWatcher: ChatWatcher;
let nameSyncWatcher: NameSyncWatcher;
let outputChannel: vscode.OutputChannel;

export async function activateWorkspace(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Discord Bridge (Workspace)');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Discord Bridge Workspace extension activating...');

  // Initialize Discord client
  discordClient = new DiscordClientManager(context, outputChannel, {
    onReady: async () => {
      outputChannel.appendLine('Discord ready, starting chat watcher...');
      // Auto-start chat watcher when Discord connects
      if (chatWatcher && !chatWatcher.isRunning()) {
        chatWatcher.start();
      }
      // Start name sync watcher (watches for chat name changes)
      if (nameSyncWatcher && !nameSyncWatcher.isWatching()) {
        await nameSyncWatcher.start();
      }
      // Reconcile any chats that were seen before Discord was ready
      if (chatWatcher) {
        await chatWatcher.reconcilePendingChats();
      }
      // Ensure cursor rules file exists for AI to know about Discord workflow
      await ensureCursorRulesExist(outputChannel);
    },
    onDisconnect: () => {
      outputChannel.appendLine('Discord disconnected');
    },
    onError: (error) => {
      outputChannel.appendLine(`Discord error: ${error.message}`);
    },
    onThreadMessage: (threadId, message, author) => {
      outputChannel.appendLine(`Thread message from ${author}: ${message.substring(0, 50)}...`);
      vscode.commands.executeCommand(Commands.ADD_LOG, `${author}: ${message.substring(0, 50)}...`);
    },
  });

  // Initialize chat watcher
  chatWatcher = new ChatWatcher(context, discordClient, {
    onNewChat: (chatId, threadId) => {
      outputChannel.appendLine(`New chat ${chatId} → thread ${threadId}`);
    },
    onChatRemoved: (chatId) => {
      outputChannel.appendLine(`Chat removed: ${chatId}`);
    },
  }, outputChannel);

  // Initialize name sync watcher (hybrid file watch + polling)
  nameSyncWatcher = new NameSyncWatcher(discordClient, outputChannel);

  // Register workspace commands
  registerWorkspaceCommands(context);

  // Auto-connect to Discord if configured
  try {
    vscode.commands.executeCommand(Commands.UPDATE_STATUS, { status: 'connecting' });
    await discordClient.connect();
  } catch (error: any) {
    outputChannel.appendLine(`Auto-connect failed: ${error.message}`);
    // Don't fail activation, just log the error
  }

  outputChannel.appendLine('Discord Bridge Workspace extension activated');
}

function registerWorkspaceCommands(context: vscode.ExtensionContext): void {
  // Public commands
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RECONNECT, async () => {
      try {
        vscode.commands.executeCommand(Commands.UPDATE_STATUS, { status: 'connecting' });
        await discordClient.disconnect();
        await discordClient.connect();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to reconnect: ${error.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.START_WATCHER, () => {
      chatWatcher.start();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.STOP_WATCHER, () => {
      chatWatcher.stop();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.SHOW_STATUS, () => {
      const status = discordClient.getStatus();
      const watcherStatus = chatWatcher.isRunning() ? 'running' : 'stopped';
      const info = [
        `Discord: ${status.connected ? `Connected as ${status.botUsername}` : 'Disconnected'}`,
        `Guilds: ${status.guildCount || 0}`,
        `Chat Watcher: ${watcherStatus}`,
        `Known Chats: ${chatWatcher.getKnownChatCount()}`,
      ];
      vscode.window.showInformationMessage(info.join(' | '));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RESYNC_THREAD_NAME, async () => {
      // Get the current/most recent chat ID
      const chatIds = chatWatcher.getKnownChatIds();
      if (chatIds.length === 0) {
        vscode.window.showWarningMessage('No active chats to resync');
        return;
      }

      // Use the most recent chat
      const chatId = chatIds[chatIds.length - 1];
      
      const result = await discordClient.resyncThreadName(chatId);
      if (result.success) {
        vscode.window.showInformationMessage(`Thread renamed to: ${result.newName}`);
      } else {
        vscode.window.showErrorMessage(`Failed to resync thread name: ${result.error}`);
      }
    })
  );

  // Internal: UI → Workspace commands
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.POST_TO_THREAD, async (params: PostToThreadParams) => {
      return discordClient.postToThread(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.SEND_FILE_TO_THREAD, async (params: SendFileToThreadParams) => {
      return discordClient.sendFileToThread(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.START_TYPING, async (params: StartTypingParams) => {
      return discordClient.startTyping(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.STOP_TYPING, async (params: StopTypingParams) => {
      return discordClient.stopTyping(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.CREATE_THREAD, async (params: CreateThreadParams) => {
      return discordClient.createThread(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RENAME_THREAD, async (params: RenameThreadParams) => {
      return discordClient.renameThread(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.ARCHIVE_THREAD, async (params: ArchiveThreadParams) => {
      return discordClient.archiveThread(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.FORWARD_USER_PROMPT, async (params: ForwardUserPromptParams) => {
      return discordClient.forwardUserPrompt(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.ASK_QUESTION, async (params: AskQuestionParams): Promise<AskQuestionResult> => {
      return discordClient.askQuestion(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.GET_DISCORD_STATUS, (): DiscordStatusResult => {
      return discordClient.getStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.GET_GUILDS, async (): Promise<GuildInfo[]> => {
      return discordClient.getGuilds();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.CREATE_PROJECT_CHANNEL, async (params: CreateChannelParams) => {
      return discordClient.createProjectChannel(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.GET_CHANNELS, async (params: GetChannelsParams): Promise<ChannelInfo[]> => {
      return discordClient.getChannels(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.GET_CATEGORIES, async (params: GetCategoriesParams): Promise<CategoryInfo[]> => {
      return discordClient.getCategories(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.SELECT_CHANNEL, async (params: SelectChannelParams): Promise<boolean> => {
      return discordClient.selectChannel(params.channelId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.CHECK_GUILD_PERMISSIONS, async (params: CheckGuildPermissionsParams): Promise<PermissionCheckResult> => {
      return discordClient.checkGuildPermissions(params);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.GET_BOT_INVITE_URL, (): string | null => {
      return discordClient.getBotInviteUrl();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.GET_THREAD_FOR_ACTIVE_CHAT, (params: { chatId: string }): GetThreadForActiveChatResult => {
      // Look up the thread ID for the given chat ID from our mappings
      const mappings = discordClient.getChatMappings();
      
      // Debug: log all mappings
      outputChannel.appendLine(`[GET_THREAD_FOR_ACTIVE_CHAT] Looking for chat ${params.chatId}`);
      outputChannel.appendLine(`[GET_THREAD_FOR_ACTIVE_CHAT] Available mappings:`);
      for (const [chatId, mapping] of mappings) {
        outputChannel.appendLine(`  - ${chatId} → ${mapping.threadId} (claimed: ${mapping.claimedAt || 'no'})`);
      }
      
      const mapping = mappings.get(params.chatId);
      
      if (mapping) {
        outputChannel.appendLine(`[GET_THREAD_FOR_ACTIVE_CHAT] Found: ${mapping.threadId}`);
        return { success: true, threadId: mapping.threadId, chatId: params.chatId };
      } else {
        outputChannel.appendLine(`[GET_THREAD_FOR_ACTIVE_CHAT] Not found!`);
        return { success: false, error: `No thread found for chat ${params.chatId}` };
      }
    })
  );

  // Resolve thread ID - finds the correct thread for this agent's chat
  // NOTE: This should only be called ONCE per chat session. Subsequent calls may return wrong data.
  // 
  // Strategy order (designed to avoid grabbing stale mappings from previous sessions):
  // 1. Check for pending composer - most likely to be this agent's chat
  // 2. Check for recent (<30s) unclaimed mapping - fresh mapping, probably ours
  // 3. Wait for new mapping - thread hasn't been created yet
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RESOLVE_THREAD_ID, async (): Promise<ResolveThreadIdResult> => {
      outputChannel.appendLine(`[RESOLVE_THREAD_ID] Starting resolution...`);
      
      const mappings = discordClient.getChatMappings();
      outputChannel.appendLine(`[RESOLVE_THREAD_ID] Available mappings:`);
      for (const [chatId, mapping] of mappings) {
        outputChannel.appendLine(`  - ${chatId} → ${mapping.threadId} (created: ${mapping.createdAt}, claimed: ${mapping.claimedAt || 'no'})`);
      }

      // Strategy 1: Check if there's a pending composer that needs thread creation
      // This is most likely to be the current agent's chat - check it FIRST
      const pendingId = chatWatcher.getPendingComposerId();
      if (pendingId) {
        outputChannel.appendLine(`[RESOLVE_THREAD_ID] Found pending composer ${pendingId}, trying to create thread...`);
        
        // First try immediately - maybe name just became available
        const immediateResult = await chatWatcher.tryCreateThreadForPendingComposer();
        if (immediateResult.success && immediateResult.threadId) {
          outputChannel.appendLine(`[RESOLVE_THREAD_ID] Created thread for pending composer: ${immediateResult.chatId} → ${immediateResult.threadId}`);
          await discordClient.markMappingClaimed(immediateResult.chatId!);
          return { success: true, threadId: immediateResult.threadId, chatId: immediateResult.chatId, method: 'waited_for_new' };
        }
        
        // Wait for pending composer to get a name
        outputChannel.appendLine(`[RESOLVE_THREAD_ID] Waiting for pending composer to get a name...`);
        const waitResult = await chatWatcher.waitForPendingComposerThread(5000, 200);
        if (waitResult.success && waitResult.threadId) {
          outputChannel.appendLine(`[RESOLVE_THREAD_ID] Created thread after waiting: ${waitResult.chatId} → ${waitResult.threadId}`);
          await discordClient.markMappingClaimed(waitResult.chatId!);
          return { success: true, threadId: waitResult.threadId, chatId: waitResult.chatId, method: 'waited_for_new' };
        }
        
        outputChannel.appendLine(`[RESOLVE_THREAD_ID] Pending composer still has no name after waiting`);
      }

      // Strategy 2: Get recent (<30s) unclaimed mapping
      // Only grab fresh mappings to avoid stale orphaned threads from previous sessions
      const recentUnclaimed = discordClient.getRecentUnclaimedMapping(30000);
      if (recentUnclaimed) {
        outputChannel.appendLine(`[RESOLVE_THREAD_ID] Using recent unclaimed: ${recentUnclaimed.chatId} → ${recentUnclaimed.threadId}`);
        await discordClient.markMappingClaimed(recentUnclaimed.chatId);
        return { success: true, threadId: recentUnclaimed.threadId, chatId: recentUnclaimed.chatId, method: 'latest_unclaimed' };
      }

      // Strategy 3: No pending composer, no recent mapping - wait for a new one
      outputChannel.appendLine(`[RESOLVE_THREAD_ID] No recent mappings, waiting for new one...`);
      const newMapping = await discordClient.waitForNewUnclaimedMapping(5000, 200, 30000);
      if (newMapping) {
        outputChannel.appendLine(`[RESOLVE_THREAD_ID] New mapping appeared: ${newMapping.chatId} → ${newMapping.threadId}`);
        await discordClient.markMappingClaimed(newMapping.chatId);
        return { success: true, threadId: newMapping.threadId, chatId: newMapping.chatId, method: 'waited_for_new' };
      }

      outputChannel.appendLine(`[RESOLVE_THREAD_ID] Failed to resolve thread ID`);
      return { success: false, error: 'Could not resolve thread ID: no mappings available' };
    })
  );
}

export function deactivateWorkspace(): void {
  outputChannel?.appendLine('Discord Bridge Workspace extension deactivating...');
  nameSyncWatcher?.stop();
  chatWatcher?.stop();
  discordClient?.disconnect();
}
