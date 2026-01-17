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
      const resolveStartTime = Date.now();
      outputChannel.appendLine(`[RESOLVE_THREAD_ID] Starting resolution at ${new Date().toISOString()}...`);
      
      const mappings = discordClient.getChatMappings();
      outputChannel.appendLine(`[RESOLVE_THREAD_ID] Available mappings (${mappings.size} total):`);
      for (const [chatId, mapping] of mappings) {
        outputChannel.appendLine(`  - ${chatId} → ${mapping.threadId} (created: ${mapping.createdAt}, claimed: ${mapping.claimedAt || 'no'})`);
      }

      // Strategy 1: Check if there's a pending composer that needs thread creation
      // This is most likely to be the current agent's chat - check it FIRST
      const pendingId = chatWatcher.getPendingComposerId();
      if (pendingId) {
        outputChannel.appendLine(`[RESOLVE_THREAD_ID] Strategy 1: Found pending composer ${pendingId}, creating thread...`);
        
        // Create thread immediately - use real name if available, otherwise use placeholder
        // NameSyncWatcher will rename the thread when the real name becomes available
        const result = await chatWatcher.tryCreateThreadForPendingComposer();
        if (result.success && result.threadId) {
          const elapsed = Date.now() - resolveStartTime;
          outputChannel.appendLine(`[RESOLVE_THREAD_ID] Strategy 1 SUCCESS: ${result.chatId} → ${result.threadId} in ${elapsed}ms`);
          await discordClient.markMappingClaimed(result.chatId!);
          return { success: true, threadId: result.threadId, chatId: result.chatId, method: 'waited_for_new' };
        }
        
        outputChannel.appendLine(`[RESOLVE_THREAD_ID] Strategy 1 FAILED: ${result.error}`);
      }

      // Strategy 2: Get recent (<30s) unclaimed mapping
      // Only grab fresh mappings to avoid stale orphaned threads from previous sessions
      const strategy2Start = Date.now();
      const recentUnclaimed = discordClient.getRecentUnclaimedMapping(30000);
      if (recentUnclaimed) {
        const elapsed = Date.now() - resolveStartTime;
        outputChannel.appendLine(`[RESOLVE_THREAD_ID] Strategy 2 SUCCESS: Using recent unclaimed ${recentUnclaimed.chatId} → ${recentUnclaimed.threadId} in ${elapsed}ms`);
        await discordClient.markMappingClaimed(recentUnclaimed.chatId);
        return { success: true, threadId: recentUnclaimed.threadId, chatId: recentUnclaimed.chatId, method: 'latest_unclaimed' };
      }
      outputChannel.appendLine(`[RESOLVE_THREAD_ID] Strategy 2 FAILED: No recent unclaimed mapping (checked in ${Date.now() - strategy2Start}ms)`);

      // Strategy 3: No pending composer, no recent mapping - wait for a new one
      const strategy3Start = Date.now();
      outputChannel.appendLine(`[RESOLVE_THREAD_ID] Strategy 3: Waiting for new mapping...`);
      const newMapping = await discordClient.waitForNewUnclaimedMapping(8000, 200, 30000);
      const strategy3Elapsed = Date.now() - strategy3Start;
      
      if (newMapping) {
        const totalElapsed = Date.now() - resolveStartTime;
        outputChannel.appendLine(`[RESOLVE_THREAD_ID] Strategy 3 SUCCESS: New mapping ${newMapping.chatId} → ${newMapping.threadId} in ${totalElapsed}ms (wait took ${strategy3Elapsed}ms)`);
        await discordClient.markMappingClaimed(newMapping.chatId);
        return { success: true, threadId: newMapping.threadId, chatId: newMapping.chatId, method: 'waited_for_new' };
      }

      const totalElapsed = Date.now() - resolveStartTime;
      outputChannel.appendLine(`[RESOLVE_THREAD_ID] ALL STRATEGIES FAILED after ${totalElapsed}ms`);
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
