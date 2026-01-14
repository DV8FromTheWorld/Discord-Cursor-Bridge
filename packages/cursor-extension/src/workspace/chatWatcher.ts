/**
 * Chat watcher for the Workspace part.
 * Monitors for new Cursor agent chats and automatically creates Discord threads.
 */

import * as vscode from 'vscode';
import { DiscordClientManager } from './discordClient';
import { Commands } from '../shared/commands';
import { getChatName, getArchivedChatIds, getAllChatIds, getActiveChatsRankedByRecency } from './cursorStorage';

export interface ChatWatcherEvents {
  onNewChat: (chatId: string, threadId: string) => void;
  onChatRemoved: (chatId: string) => void;
}

// How often to check for Discord auto-archived threads (in poll cycles)
// Since we poll every second, 30 = check every 30 seconds
const DISCORD_ARCHIVE_CHECK_INTERVAL = 30;

export class ChatWatcher {
  private allTimeSeenIds: Set<string> = new Set();
  private archivedChatIds: Set<string> = new Set(); // Chats we've already processed as archived (via DB isArchived flag)
  private pendingComposerId: string | null = null; // ONE unnamed composer waiting for a name
  private watcherInterval: NodeJS.Timeout | null = null;
  private pollCounter: number = 0; // Counter for less frequent checks
  private context: vscode.ExtensionContext;
  private discordClient: DiscordClientManager;
  private events: ChatWatcherEvents;
  private outputChannel: vscode.OutputChannel;

  constructor(
    context: vscode.ExtensionContext,
    discordClient: DiscordClientManager,
    events: ChatWatcherEvents,
    outputChannel: vscode.OutputChannel
  ) {
    this.context = context;
    this.discordClient = discordClient;
    this.events = events;
    this.outputChannel = outputChannel;
    this.loadPersistedIds();
  }

  private loadPersistedIds(): void {
    const saved = this.context.workspaceState.get<string[]>('allTimeSeenChatIds', []);
    this.allTimeSeenIds = new Set(saved);
    
    const savedArchived = this.context.workspaceState.get<string[]>('archivedChatIds', []);
    this.archivedChatIds = new Set(savedArchived);
    
    this.outputChannel.appendLine(`Loaded ${this.allTimeSeenIds.size} previously seen chat IDs, ${this.archivedChatIds.size} archived`);
  }

  private persistIds(): void {
    this.context.workspaceState.update('allTimeSeenChatIds', [...this.allTimeSeenIds]);
    this.context.workspaceState.update('archivedChatIds', [...this.archivedChatIds]);
  }

  public async start(): Promise<void> {
    if (this.watcherInterval) {
      this.outputChannel.appendLine('Watcher already running');
      return;
    }

    // Get initial state from database - record all existing chats
    const initialIds = await getAllChatIds(this.outputChannel);
    initialIds.forEach((id) => this.allTimeSeenIds.add(id));
    this.persistIds();

    this.outputChannel.appendLine(
      `Starting chat watcher. Database chats: ${initialIds.length}, All-time seen: ${this.allTimeSeenIds.size}`
    );

    // Notify via log
    vscode.commands.executeCommand(Commands.ADD_LOG, 'Chat watcher started');

    // Poll every second
    this.watcherInterval = setInterval(async () => {
      try {
        // Get all chat IDs from database (single source of truth)
        const allDbChatIds = await getAllChatIds(this.outputChannel);

        // Check for new chats
        for (const id of allDbChatIds) {
          if (!this.allTimeSeenIds.has(id)) {
            // Truly new chat detected!
            this.outputChannel.appendLine(`[NEW CHAT] ${id}`);
            this.allTimeSeenIds.add(id);
            this.persistIds();

            // Check if it has a name yet
            const chatName = await getChatName(id, this.outputChannel);
            if (chatName) {
              // Has a name - create thread immediately
              this.outputChannel.appendLine(`[NEW CHAT] Has name "${chatName}", creating thread`);
              await this.createThreadForChat(id, chatName);
            } else {
              // No name yet - store as pending (only keep ONE)
              if (this.pendingComposerId && this.pendingComposerId !== id) {
                this.outputChannel.appendLine(`[PENDING] Replacing pending composer ${this.pendingComposerId} with ${id}`);
              }
              this.pendingComposerId = id;
              this.outputChannel.appendLine(`[PENDING] Composer ${id} waiting for name before thread creation`);
            }
          }
        }

        // Check if pending composer now has a name
        if (this.pendingComposerId) {
          const pendingName = await getChatName(this.pendingComposerId, this.outputChannel);
          if (pendingName) {
            this.outputChannel.appendLine(`[PENDING] Composer ${this.pendingComposerId} now has name "${pendingName}", creating thread`);
            await this.createThreadForChat(this.pendingComposerId, pendingName);
            this.pendingComposerId = null;
          }
        }

        // Check for archived chats directly from database
        // NOTE: We ONLY use the database isArchived flag now. The old "removed from visible list"
        // method was buggy because getOrderedSelectedComposerIds only returns currently SELECTED
        // composers, not all open ones. When clicking through chats, this caused false archiving.
        const dbArchivedIds = await getArchivedChatIds();
        for (const id of dbArchivedIds) {
          if (this.allTimeSeenIds.has(id) && !this.archivedChatIds.has(id)) {
            // Chat is archived in DB but we haven't processed it yet
            this.outputChannel.appendLine(`[CHAT ARCHIVED IN DB] ${id}`);
            await this.archiveThreadForChat(id);
            this.archivedChatIds.add(id);
            this.persistIds();
            this.events.onChatRemoved(id);
          }
        }

        // Check for unarchived chats - chats we thought were archived but aren't anymore
        for (const id of this.archivedChatIds) {
          if (!dbArchivedIds.has(id)) {
            // Chat was unarchived in Cursor - reopen the Discord thread
            this.outputChannel.appendLine(`[CHAT UNARCHIVED IN DB] ${id}`);
            await this.unarchiveThreadForChat(id);
            this.archivedChatIds.delete(id);
            this.persistIds();
          }
        }

        // Periodically check for Discord auto-archived threads
        // Discord can auto-archive threads after inactivity, so we reopen them if the Cursor chat is "truly active"
        // We respect implicit archiving: chats that are old and far down the list stay archived
        this.pollCounter++;
        if (this.pollCounter >= DISCORD_ARCHIVE_CHECK_INTERVAL) {
          this.pollCounter = 0;
          
          // Get config for implicit archive thresholds (from UI extension via command)
          const config = await vscode.commands.executeCommand<{ implicitArchiveCount?: number; implicitArchiveHours?: number }>(Commands.GET_CONFIG);
          const implicitArchiveCount = config?.implicitArchiveCount ?? 10;
          const implicitArchiveHours = config?.implicitArchiveHours ?? 48;
          const implicitArchiveMs = implicitArchiveHours * 60 * 60 * 1000;
          const now = Date.now();

          // Get active chats ranked by recency
          const rankedChats = await getActiveChatsRankedByRecency(this.outputChannel);
          
          // Only include chats that are "truly active":
          // - Position < implicitArchiveCount (one of the top N recent chats), OR
          // - lastUpdatedAt is within implicitArchiveHours
          const trulyActiveChatIds = new Set<string>();
          for (const chat of rankedChats) {
            const isTopN = chat.position < implicitArchiveCount;
            const isRecentlyUsed = chat.lastUpdatedAt && (now - chat.lastUpdatedAt) < implicitArchiveMs;
            
            if (isTopN || isRecentlyUsed) {
              trulyActiveChatIds.add(chat.chatId);
            }
          }
          
          // Ensure their Discord threads are open
          const reopened = await this.discordClient.ensureActiveThreadsOpen(trulyActiveChatIds);
          if (reopened > 0) {
            this.outputChannel.appendLine(`[DISCORD AUTO-ARCHIVE] Reopened ${reopened} thread(s) (top ${implicitArchiveCount} or active in last ${implicitArchiveHours}h)`);
            vscode.commands.executeCommand(Commands.ADD_LOG, `Reopened ${reopened} auto-archived thread(s)`);
          }
        }
      } catch (error: any) {
        this.outputChannel.appendLine(`Watcher error: ${error.message}`);
      }
    }, 1000);

    vscode.window.showInformationMessage('Discord Bridge: Chat watcher started');
  }

  private async archiveThreadForChat(chatId: string): Promise<void> {
    if (!this.discordClient.isReady()) {
      this.outputChannel.appendLine(`Discord not ready, skipping thread archive for ${chatId}`);
      return;
    }

    const result = await this.discordClient.archiveThread({ chatId });

    if (result.success) {
      this.outputChannel.appendLine(`Thread archived for chat ${chatId}`);
      vscode.commands.executeCommand(Commands.ADD_LOG, `Thread archived for chat ${chatId.substring(0, 8)}...`);
    } else {
      // Don't show error if no mapping exists - chat may not have had a thread
      if (!result.error?.includes('No thread mapping')) {
        this.outputChannel.appendLine(`Failed to archive thread: ${result.error}`);
      }
    }
  }

  private async unarchiveThreadForChat(chatId: string): Promise<void> {
    if (!this.discordClient.isReady()) {
      this.outputChannel.appendLine(`Discord not ready, skipping thread unarchive for ${chatId}`);
      return;
    }

    // Clear explicit archive flag - user is unarchiving in Cursor, so they want it active
    await this.discordClient.clearExplicitArchiveForChat(chatId);

    const result = await this.discordClient.unarchiveThread({ chatId });

    if (result.success) {
      this.outputChannel.appendLine(`Thread unarchived for chat ${chatId}`);
      vscode.commands.executeCommand(Commands.ADD_LOG, `Thread reopened for chat ${chatId.substring(0, 8)}...`);
    } else {
      // Don't show error if no mapping exists - chat may not have had a thread
      if (!result.error?.includes('No thread mapping')) {
        this.outputChannel.appendLine(`Failed to unarchive thread: ${result.error}`);
      }
    }
  }

  /**
   * Create a Discord thread for a chat.
   * @param chatId The chat ID
   * @param knownName Optional - if we already know the name, pass it to avoid re-fetching
   * @returns The thread ID if successful, null otherwise
   */
  private async createThreadForChat(chatId: string, knownName?: string): Promise<string | null> {
    if (!this.discordClient.isReady()) {
      this.outputChannel.appendLine(`Discord not ready, skipping thread creation for ${chatId}`);
      return null;
    }

    const workspaceName = vscode.workspace.name || 'unnamed';
    
    // Use provided name or fetch it
    const chatName = knownName || await getChatName(chatId, this.outputChannel);
    
    if (!chatName) {
      // No name - don't create thread (caller should handle this as pending)
      this.outputChannel.appendLine(`Cannot create thread for ${chatId}: no name available`);
      return null;
    }

    this.outputChannel.appendLine(`Creating thread for ${chatId} with name "${chatName}"`);

    const result = await this.discordClient.createThread({
      chatId,
      workspaceName,
      name: chatName,
    });

    if (result.success && result.threadId) {
      this.outputChannel.appendLine(`Thread created: ${result.threadName} (${result.threadId})`);
      vscode.commands.executeCommand(Commands.ADD_LOG, `Thread created: ${result.threadName}`);
      this.events.onNewChat(chatId, result.threadId);
      return result.threadId;
    } else {
      this.outputChannel.appendLine(`Failed to create thread: ${result.error}`);
      vscode.commands.executeCommand(Commands.ADD_LOG, `Failed to create thread: ${result.error}`);
      return null;
    }
  }

  public stop(): void {
    if (this.watcherInterval) {
      clearInterval(this.watcherInterval);
      this.watcherInterval = null;
      this.outputChannel.appendLine('Chat watcher stopped');
      vscode.commands.executeCommand(Commands.ADD_LOG, 'Chat watcher stopped');
      vscode.window.showInformationMessage('Discord Bridge: Chat watcher stopped');
    }
  }

  public isRunning(): boolean {
    return this.watcherInterval !== null;
  }

  public getKnownChatIds(): string[] {
    return [...this.allTimeSeenIds];
  }

  public getKnownChatCount(): number {
    return this.allTimeSeenIds.size;
  }

  public clearKnownChats(): void {
    this.allTimeSeenIds = new Set();
    this.archivedChatIds = new Set();
    this.pendingComposerId = null;
    this.persistIds();
    this.outputChannel.appendLine('Cleared all known chat IDs and archived IDs');
    vscode.window.showInformationMessage('Discord Bridge: Cleared known chats');
  }

  /**
   * Get the pending composer ID (if any).
   * A pending composer is one that exists but hasn't been given a name yet.
   */
  public getPendingComposerId(): string | null {
    return this.pendingComposerId;
  }

  /**
   * Try to create a thread for the pending composer if it now has a name.
   * This is used by RESOLVE_THREAD_ID when an agent requests their thread ID
   * but the thread hasn't been created yet because we were waiting for a name.
   * 
   * @returns Object with threadId if successful, or error message
   */
  public async tryCreateThreadForPendingComposer(): Promise<{ success: boolean; threadId?: string; chatId?: string; error?: string }> {
    if (!this.pendingComposerId) {
      return { success: false, error: 'No pending composer' };
    }

    const chatId = this.pendingComposerId;
    const chatName = await getChatName(chatId, this.outputChannel);
    
    if (!chatName) {
      return { success: false, error: 'Pending composer still has no name' };
    }

    this.outputChannel.appendLine(`[ON-DEMAND] Creating thread for pending composer ${chatId} with name "${chatName}"`);
    const threadId = await this.createThreadForChat(chatId, chatName);
    
    if (threadId) {
      this.pendingComposerId = null;
      return { success: true, threadId, chatId };
    } else {
      return { success: false, error: 'Failed to create thread' };
    }
  }

  /**
   * Wait for the pending composer to get a name and create a thread.
   * Used when RESOLVE_THREAD_ID is called but we're still waiting.
   * 
   * @param timeoutMs Maximum time to wait
   * @param pollIntervalMs How often to check
   * @returns Object with threadId if successful
   */
  public async waitForPendingComposerThread(timeoutMs: number = 5000, pollIntervalMs: number = 200): Promise<{ success: boolean; threadId?: string; chatId?: string; error?: string }> {
    if (!this.pendingComposerId) {
      return { success: false, error: 'No pending composer' };
    }

    const startTime = Date.now();
    const chatId = this.pendingComposerId;
    
    this.outputChannel.appendLine(`[WAIT] Waiting for pending composer ${chatId} to get a name (timeout: ${timeoutMs}ms)...`);

    while (Date.now() - startTime < timeoutMs) {
      const chatName = await getChatName(chatId, this.outputChannel);
      
      if (chatName) {
        this.outputChannel.appendLine(`[WAIT] Pending composer got name "${chatName}", creating thread...`);
        const threadId = await this.createThreadForChat(chatId, chatName);
        
        if (threadId) {
          this.pendingComposerId = null;
          return { success: true, threadId, chatId };
        } else {
          return { success: false, error: 'Failed to create thread' };
        }
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    this.outputChannel.appendLine(`[WAIT] Timeout waiting for pending composer to get a name`);
    return { success: false, error: 'Timeout waiting for composer name' };
  }

  /**
   * Reconcile chats that were seen before Discord was ready.
   * Creates threads for any chats in allTimeSeenIds that don't have mappings AND have names.
   * Chats without names are skipped (they may be stale or will be handled as pending).
   */
  public async reconcilePendingChats(): Promise<void> {
    if (!this.discordClient.isReady()) {
      this.outputChannel.appendLine('Cannot reconcile: Discord not ready');
      return;
    }

    const mappings = this.discordClient.getChatMappings();
    const chatsWithoutThreads = [...this.allTimeSeenIds].filter(
      (chatId) => !mappings.has(chatId) && chatId !== this.pendingComposerId
    );

    if (chatsWithoutThreads.length === 0) {
      this.outputChannel.appendLine('No chats pending thread creation');
      return;
    }

    this.outputChannel.appendLine(
      `Reconciling ${chatsWithoutThreads.length} chats without threads`
    );

    for (const chatId of chatsWithoutThreads) {
      // Only create threads for chats that have names
      const chatName = await getChatName(chatId, this.outputChannel);
      if (chatName) {
        await this.createThreadForChat(chatId, chatName);
      } else {
        this.outputChannel.appendLine(`Skipping ${chatId} during reconciliation - no name (may be stale)`);
      }
    }
  }
}
