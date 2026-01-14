/**
 * Name Sync Watcher
 * 
 * Watches for chat name changes in Cursor's storage and automatically syncs
 * them to Discord thread names. Uses a hybrid approach for reliability:
 * 
 * 1. PRIMARY: File watcher on state.vscdb + state.vscdb-wal (fast response)
 * 2. BACKUP: Polling every 30 seconds (catches missed events)
 * 3. WATCHDOG: Verifies file watcher is alive, restarts if needed
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DiscordClientManager } from './discordClient';
import { getAllChatNames } from './cursorStorage';
import { Commands } from '../shared/commands';

// Configuration
const FILE_WATCH_DEBOUNCE_MS = 500;      // Debounce file change events
const BACKUP_POLL_INTERVAL_MS = 30000;   // Backup poll every 30 seconds
const WATCHDOG_INTERVAL_MS = 60000;      // Check watcher health every 60 seconds
const WATCHDOG_TIMEOUT_MS = 5000;        // How long to wait for watcher response

// Temporary thread name used when chat name isn't available yet
const TEMPORARY_THREAD_NAME = 'New chat...';

interface WatcherState {
  watcher: fs.FSWatcher | null;
  lastEventTime: number;
  isHealthy: boolean;
}

export class NameSyncWatcher {
  private outputChannel: vscode.OutputChannel;
  private discordClient: DiscordClientManager;
  
  // Cached chat names for comparison (chatId -> name)
  private cachedNames: Map<string, string> = new Map();
  
  // File watchers
  private dbWatcher: WatcherState = { watcher: null, lastEventTime: 0, isHealthy: false };
  private walWatcher: WatcherState = { watcher: null, lastEventTime: 0, isHealthy: false };
  
  // Timers
  private debounceTimer: NodeJS.Timeout | null = null;
  private backupPollTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  
  // Database paths
  private dbPath: string | null = null;
  private walPath: string | null = null;
  
  private isRunning: boolean = false;
  private isSyncing: boolean = false; // Prevents concurrent syncs

  constructor(
    discordClient: DiscordClientManager,
    outputChannel: vscode.OutputChannel
  ) {
    this.discordClient = discordClient;
    this.outputChannel = outputChannel;
  }

  /**
   * Start watching for name changes.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.outputChannel.appendLine('[NameSync] Already running');
      return;
    }

    this.outputChannel.appendLine('[NameSync] Starting hybrid name sync watcher...');
    
    // Find the database paths
    const storagePath = this.getWorkspaceStoragePath();
    if (!storagePath) {
      this.outputChannel.appendLine('[NameSync] Could not find Cursor workspace storage path');
      // Still start backup polling - it might work later
    } else {
      this.dbPath = path.join(storagePath, 'state.vscdb');
      this.walPath = path.join(storagePath, 'state.vscdb-wal');
      this.outputChannel.appendLine(`[NameSync] Database path: ${this.dbPath}`);
    }

    // Initialize cache from Discord (not Cursor) so we detect mismatches
    await this.initializeCacheFromDiscord();
    
    // Start file watchers (primary)
    this.startFileWatchers();
    
    // Start backup polling
    this.startBackupPolling();
    
    // Start watchdog
    this.startWatchdog();
    
    this.isRunning = true;
    this.outputChannel.appendLine('[NameSync] Watcher started successfully');
    vscode.commands.executeCommand(Commands.ADD_LOG, 'Name sync watcher started');
    
    // Immediately sync any out-of-date threads
    await this.checkAndSyncNames();
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.outputChannel.appendLine('[NameSync] Stopping name sync watcher...');
    
    // Stop file watchers
    this.stopFileWatchers();
    
    // Stop timers
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.backupPollTimer) {
      clearInterval(this.backupPollTimer);
      this.backupPollTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    
    this.isRunning = false;
    this.outputChannel.appendLine('[NameSync] Watcher stopped');
    vscode.commands.executeCommand(Commands.ADD_LOG, 'Name sync watcher stopped');
  }

  /**
   * Check if the watcher is running.
   */
  isWatching(): boolean {
    return this.isRunning;
  }

  // ============ File Watching (Primary) ============

  private startFileWatchers(): void {
    if (!this.dbPath) {
      this.outputChannel.appendLine('[NameSync] No database path, skipping file watchers');
      return;
    }

    // Watch main database file
    if (fs.existsSync(this.dbPath)) {
      try {
        this.dbWatcher.watcher = fs.watch(this.dbPath, (eventType) => {
          this.dbWatcher.lastEventTime = Date.now();
          this.dbWatcher.isHealthy = true;
          this.onFileChanged(`db:${eventType}`);
        });
        this.dbWatcher.isHealthy = true;
        this.outputChannel.appendLine('[NameSync] Watching state.vscdb');
      } catch (error: any) {
        this.outputChannel.appendLine(`[NameSync] Failed to watch state.vscdb: ${error.message}`);
      }
    }

    // Watch WAL file (may not exist yet)
    if (this.walPath && fs.existsSync(this.walPath)) {
      try {
        this.walWatcher.watcher = fs.watch(this.walPath, (eventType) => {
          this.walWatcher.lastEventTime = Date.now();
          this.walWatcher.isHealthy = true;
          this.onFileChanged(`wal:${eventType}`);
        });
        this.walWatcher.isHealthy = true;
        this.outputChannel.appendLine('[NameSync] Watching state.vscdb-wal');
      } catch (error: any) {
        this.outputChannel.appendLine(`[NameSync] Failed to watch state.vscdb-wal: ${error.message}`);
      }
    }
  }

  private stopFileWatchers(): void {
    if (this.dbWatcher.watcher) {
      this.dbWatcher.watcher.close();
      this.dbWatcher.watcher = null;
      this.dbWatcher.isHealthy = false;
    }
    if (this.walWatcher.watcher) {
      this.walWatcher.watcher.close();
      this.walWatcher.watcher = null;
      this.walWatcher.isHealthy = false;
    }
  }

  /**
   * Called when a file change is detected (debounced).
   */
  private onFileChanged(source: string): void {
    // Debounce rapid file changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      this.outputChannel.appendLine(`[NameSync] File change detected (${source}), checking names...`);
      await this.checkAndSyncNames();
    }, FILE_WATCH_DEBOUNCE_MS);
  }

  // ============ Backup Polling ============

  private startBackupPolling(): void {
    this.backupPollTimer = setInterval(async () => {
      this.outputChannel.appendLine('[NameSync] Backup poll triggered');
      await this.checkAndSyncNames();
    }, BACKUP_POLL_INTERVAL_MS);
  }

  // ============ Watchdog ============

  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      this.checkWatcherHealth();
    }, WATCHDOG_INTERVAL_MS);
  }

  private checkWatcherHealth(): void {
    // If we don't have file watchers, try to start them
    if (!this.dbWatcher.watcher && this.dbPath && fs.existsSync(this.dbPath)) {
      this.outputChannel.appendLine('[NameSync] Watchdog: Attempting to restart file watchers...');
      vscode.commands.executeCommand(Commands.ADD_LOG, 'Watchdog restarting file watchers');
      this.startFileWatchers();
      return;
    }

    // Check if WAL watcher died but file now exists
    if (!this.walWatcher.watcher && this.walPath && fs.existsSync(this.walPath)) {
      try {
        this.walWatcher.watcher = fs.watch(this.walPath, (eventType) => {
          this.walWatcher.lastEventTime = Date.now();
          this.walWatcher.isHealthy = true;
          this.onFileChanged(`wal:${eventType}`);
        });
        this.walWatcher.isHealthy = true;
        this.outputChannel.appendLine('[NameSync] Watchdog: Started watching WAL file');
      } catch (error: any) {
        this.outputChannel.appendLine(`[NameSync] Watchdog: Failed to watch WAL: ${error.message}`);
      }
    }

    // Log watcher status
    const dbStatus = this.dbWatcher.watcher ? 'active' : 'inactive';
    const walStatus = this.walWatcher.watcher ? 'active' : 'inactive';
    this.outputChannel.appendLine(`[NameSync] Watchdog: db=${dbStatus}, wal=${walStatus}`);
  }

  // ============ Name Sync Logic ============

  /**
   * Initialize the cache with actual Discord thread names.
   * This ensures we detect mismatches between Discord and Cursor on startup.
   */
  private async initializeCacheFromDiscord(): Promise<void> {
    try {
      // Fetch actual thread names from Discord (not Cursor)
      // This way the first sync will detect any threads that are out of sync
      const discordNames = await this.discordClient.getDiscordThreadNames();
      this.cachedNames = discordNames;
      this.outputChannel.appendLine(`[NameSync] Initialized cache from ${discordNames.size} Discord threads`);
      
      // Check for stale mappings (threads that no longer exist)
      const mappings = this.discordClient.getChatMappings();
      const cursorNames = await getAllChatNames(this.outputChannel);
      
      let outOfSyncCount = 0;
      let staleCount = 0;
      
      for (const [chatId, mapping] of mappings) {
        const discordName = discordNames.get(chatId);
        const cursorName = cursorNames.get(chatId);
        
        if (!discordName) {
          // Thread doesn't exist in Discord anymore (deleted or inaccessible)
          staleCount++;
          this.outputChannel.appendLine(`[NameSync] Stale mapping: ${chatId} → ${mapping.threadId} (thread not found)`);
          // Mark as "stale" in cache so we don't try to rename it
          // Using a special marker that won't match any real name
          this.cachedNames.set(chatId, `__STALE__${chatId}`);
        } else if (cursorName && cursorName !== discordName) {
          outOfSyncCount++;
          this.outputChannel.appendLine(`[NameSync] Out of sync: "${discordName}" (Discord) vs "${cursorName}" (Cursor)`);
        }
      }
      
      if (staleCount > 0) {
        this.outputChannel.appendLine(`[NameSync] Found ${staleCount} stale mappings (threads deleted or inaccessible)`);
        vscode.commands.executeCommand(Commands.ADD_LOG, `Found ${staleCount} stale thread mappings`);
      }
      if (outOfSyncCount > 0) {
        this.outputChannel.appendLine(`[NameSync] Found ${outOfSyncCount} threads needing sync`);
        vscode.commands.executeCommand(Commands.ADD_LOG, `Found ${outOfSyncCount} threads needing sync`);
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[NameSync] Failed to initialize cache: ${error.message}`);
      // Fall back to empty cache - first sync will detect all mismatches
      this.cachedNames = new Map();
    }
  }

  /**
   * Check for name changes and sync to Discord.
   */
  private async checkAndSyncNames(): Promise<void> {
    // Prevent concurrent syncs
    if (this.isSyncing) {
      this.outputChannel.appendLine('[NameSync] Sync already in progress, skipping');
      return;
    }

    if (!this.discordClient.isReady()) {
      this.outputChannel.appendLine('[NameSync] Discord not ready, skipping sync');
      return;
    }

    this.isSyncing = true;
    
    try {
      // Get current names from Cursor's storage
      const currentNames = await getAllChatNames(this.outputChannel);
      
      // Get all chat mappings (chatId -> threadId)
      const mappings = this.discordClient.getChatMappings();
      
      // Track sync statistics
      let syncedCount = 0;
      let skippedStale = 0;
      let skippedNoName = 0;
      let failedCount = 0;
      let alreadySynced = 0;
      
      // Check each mapped chat for name changes
      for (const [chatId, mapping] of mappings) {
        const currentName = currentNames.get(chatId);
        const cachedName = this.cachedNames.get(chatId);
        
        // Skip if no current name (not populated yet)
        if (!currentName) {
          skippedNoName++;
          continue;
        }
        
        // Skip stale mappings (threads that no longer exist)
        if (cachedName?.startsWith('__STALE__')) {
          skippedStale++;
          continue;
        }
        
        // Check if name changed
        const nameChanged = currentName !== cachedName;
        
        // Also sync if the thread has the temporary name
        // (handles case where thread was created before name was available)
        const needsSync = nameChanged || cachedName === TEMPORARY_THREAD_NAME || !cachedName;
        
        if (needsSync) {
          this.outputChannel.appendLine(
            `[NameSync] Name change detected for ${chatId}: "${cachedName || '(none)'}" → "${currentName}" (thread: ${mapping.threadId})`
          );
          
          // Rename the Discord thread
          const result = await this.discordClient.renameThread({
            threadId: mapping.threadId,
            name: currentName,
          });
          
          if (result.success) {
            this.outputChannel.appendLine(`[NameSync] Thread renamed to "${currentName}"`);
            vscode.commands.executeCommand(Commands.ADD_LOG, `Thread renamed: ${currentName}`);
            syncedCount++;
            // Update cache
            this.cachedNames.set(chatId, currentName);
          } else {
            this.outputChannel.appendLine(`[NameSync] Failed to rename thread ${mapping.threadId}: ${result.error}`);
            vscode.commands.executeCommand(Commands.ADD_LOG, `Failed to rename thread: ${result.error}`);
            failedCount++;
            
            // If thread doesn't exist, mark it in cache to avoid retrying
            if (result.error?.includes('Unknown Channel') || result.error?.includes('not found')) {
              this.outputChannel.appendLine(`[NameSync] Thread ${mapping.threadId} appears deleted, marking as stale`);
              // Cache the current name so we don't keep trying
              this.cachedNames.set(chatId, currentName);
            }
          }
        } else {
          alreadySynced++;
        }
      }
      
      // Log sync summary
      const total = mappings.size;
      this.outputChannel.appendLine(
        `[NameSync] Sync complete: ${syncedCount} renamed, ${alreadySynced} already synced, ${skippedStale} stale, ${skippedNoName} no name, ${failedCount} failed (${total} total mappings)`
      );
      
      // Only show in UI if something actually happened
      if (syncedCount > 0 || failedCount > 0) {
        vscode.commands.executeCommand(Commands.ADD_LOG, 
          `Sync: ${syncedCount} renamed${failedCount > 0 ? `, ${failedCount} failed` : ''}`
        );
      }
      
      // Update cache with current names, but preserve stale markers
      for (const [chatId, name] of currentNames) {
        // Don't overwrite stale markers
        if (!this.cachedNames.get(chatId)?.startsWith('__STALE__')) {
          this.cachedNames.set(chatId, name);
        }
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[NameSync] Error checking names: ${error.message}`);
    } finally {
      this.isSyncing = false;
    }
  }

  // ============ Utility ============

  /**
   * Get the path to Cursor's workspaceStorage for the current workspace.
   */
  private getWorkspaceStoragePath(): string | undefined {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) {
      return undefined;
    }

    // Cursor's storage location varies by platform
    let cursorStorageBase: string;
    if (process.platform === 'darwin') {
      cursorStorageBase = path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    } else if (process.platform === 'win32') {
      cursorStorageBase = path.join(homeDir, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage');
    } else {
      // Linux
      cursorStorageBase = path.join(homeDir, '.config', 'Cursor', 'User', 'workspaceStorage');
    }

    if (!fs.existsSync(cursorStorageBase)) {
      return undefined;
    }

    // Find the workspace storage folder that matches our current workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    
    // Scan workspaceStorage folders to find the one for this workspace
    const storageFolders = fs.readdirSync(cursorStorageBase);
    for (const folder of storageFolders) {
      const workspaceJsonPath = path.join(cursorStorageBase, folder, 'workspace.json');
      if (fs.existsSync(workspaceJsonPath)) {
        try {
          const workspaceJson = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8'));
          const folderUri = workspaceJson.folder || workspaceJson.workspace;
          if (folderUri) {
            const folderPath = folderUri.replace(/^file:\/\//, '');
            if (folderPath === workspacePath) {
              return path.join(cursorStorageBase, folder);
            }
          }
        } catch {
          // Skip invalid workspace.json files
        }
      }
    }

    return undefined;
  }

  /**
   * Force an immediate sync (useful for manual triggers).
   */
  async forceSync(): Promise<void> {
    this.outputChannel.appendLine('[NameSync] Force sync triggered');
    await this.checkAndSyncNames();
  }
}
