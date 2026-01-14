/**
 * Cursor Storage Reader
 * Reads chat/composer data from Cursor's internal SQLite database.
 * 
 * WARNING: This reads Cursor's internal storage format which may change without notice.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ComposerHead {
  type: 'head';
  composerId: string;
  name: string;
  subtitle?: string;
  createdAt: number;
  lastUpdatedAt: number;
  unifiedMode: string;
  isArchived: boolean;
  isDraft: boolean;
}

interface ComposerData {
  allComposers: ComposerHead[];
}

/**
 * Get the path to Cursor's workspaceStorage for the current workspace.
 * The workspace ID is derived from VS Code's internal storage mechanisms.
 */
function getWorkspaceStoragePath(): string | undefined {
  // VS Code/Cursor stores workspace data in:
  // ~/Library/Application Support/Cursor/User/workspaceStorage/{workspace-id}/
  // 
  // We can find the workspace-id by looking at the globalStorageUri and deriving from there,
  // or by scanning the workspaceStorage folders for one that matches our workspace.
  
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
        // workspace.json contains { "folder": "file:///path/to/workspace" }
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
 * Read composer data from Cursor's SQLite database using the sqlite3 CLI.
 * Returns undefined if the data cannot be read.
 */
async function readComposerData(outputChannel?: vscode.OutputChannel): Promise<ComposerData | undefined> {
  const storagePath = getWorkspaceStoragePath();
  if (!storagePath) {
    outputChannel?.appendLine('Could not find Cursor workspace storage path');
    return undefined;
  }

  const dbPath = path.join(storagePath, 'state.vscdb');
  if (!fs.existsSync(dbPath)) {
    outputChannel?.appendLine(`Database not found at ${dbPath}`);
    return undefined;
  }

  try {
    // Use sqlite3 CLI to read the composer data
    // The value is stored as a JSON string in the ItemTable
    const query = `SELECT value FROM ItemTable WHERE key = 'composer.composerData';`;
    const { stdout } = await execAsync(`sqlite3 "${dbPath}" "${query}"`, {
      timeout: 5000, // 5 second timeout
    });

    if (!stdout.trim()) {
      outputChannel?.appendLine('No composer data found in database');
      return undefined;
    }

    const composerData = JSON.parse(stdout.trim()) as ComposerData;
    return composerData;
  } catch (error: any) {
    outputChannel?.appendLine(`Error reading composer data: ${error.message}`);
    return undefined;
  }
}

/**
 * Get the name of a Cursor chat/composer by its ID.
 * Returns undefined if the name cannot be found.
 */
export async function getChatName(
  composerId: string,
  outputChannel?: vscode.OutputChannel
): Promise<string | undefined> {
  const composerData = await readComposerData(outputChannel);
  if (!composerData) {
    return undefined;
  }

  const composer = composerData.allComposers.find(c => c.composerId === composerId);
  if (!composer) {
    outputChannel?.appendLine(`Composer ${composerId} not found in data`);
    return undefined;
  }

  // Return the name if it exists and isn't empty
  if (composer.name && composer.name.trim()) {
    outputChannel?.appendLine(`Found chat name for ${composerId}: "${composer.name}"`);
    return composer.name;
  }

  return undefined;
}

/**
 * Get all known composer names as a map of composerId -> name.
 * Useful for debugging or batch lookups.
 */
export async function getAllChatNames(
  outputChannel?: vscode.OutputChannel
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const composerData = await readComposerData(outputChannel);
  
  if (composerData) {
    for (const composer of composerData.allComposers) {
      if (composer.name && composer.name.trim()) {
        names.set(composer.composerId, composer.name);
      }
    }
  }

  return names;
}

/**
 * Get a set of all archived chat IDs by reading directly from Cursor's database.
 * This is more reliable than checking the visible composer list since the database
 * updates immediately when a chat is archived.
 */
export async function getArchivedChatIds(
  outputChannel?: vscode.OutputChannel
): Promise<Set<string>> {
  const archivedIds = new Set<string>();
  const composerData = await readComposerData(outputChannel);
  
  if (composerData) {
    for (const composer of composerData.allComposers) {
      if (composer.isArchived) {
        archivedIds.add(composer.composerId);
      }
    }
  }

  return archivedIds;
}

/**
 * Get all chat IDs from the database.
 * This is the single source of truth for what chats exist.
 */
export async function getAllChatIds(
  outputChannel?: vscode.OutputChannel
): Promise<string[]> {
  const composerData = await readComposerData(outputChannel);
  
  if (!composerData) {
    return [];
  }

  return composerData.allComposers.map(c => c.composerId);
}

export interface ChatWithRecency {
  chatId: string;
  lastUpdatedAt: number | undefined;
  position: number; // 0 = most recent
}

/**
 * Get all non-archived chats sorted by recency (most recent first).
 * Returns position and lastUpdatedAt for each chat, useful for implicit archive logic.
 */
export async function getActiveChatsRankedByRecency(
  outputChannel?: vscode.OutputChannel
): Promise<ChatWithRecency[]> {
  const composerData = await readComposerData(outputChannel);
  
  if (!composerData) {
    return [];
  }

  // Filter to non-archived chats and sort by lastUpdatedAt descending
  const activeChats = composerData.allComposers
    .filter(c => !c.isArchived)
    .sort((a, b) => {
      // Chats with lastUpdatedAt come first, sorted by recency
      // Chats without lastUpdatedAt (never used) go to the end
      const aTime = a.lastUpdatedAt ?? 0;
      const bTime = b.lastUpdatedAt ?? 0;
      return bTime - aTime;
    });

  return activeChats.map((c, index) => ({
    chatId: c.composerId,
    lastUpdatedAt: c.lastUpdatedAt,
    position: index,
  }));
}
