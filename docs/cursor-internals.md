# Cursor Internal APIs and Storage

This document details the undocumented Cursor APIs and internal storage mechanisms discovered during development of the Discord Bridge extension.

> **WARNING**: These are internal, undocumented APIs that may change without notice between Cursor versions. Use at your own risk.

## VS Code Commands

### `composer.getOrderedSelectedComposerIds`

```typescript
const ids = await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds');
// Returns: ['uuid-1', 'uuid-2', ...] or undefined
```

**What it does**: Returns an array of composer (chat) IDs that are currently **selected** in the Cursor UI.

**Key characteristics**:
- Returns IDs in **selection order** (most recently selected first)
- Updates **immediately** when a new composer is created (before the database is flushed)
- Only returns composers that are **currently visible/selected** in the UI
- Returns `undefined` or throws if command doesn't exist (version compatibility)

**Important limitations**:
- Does **NOT** return all open composers, only the currently selected ones
- When you click on a different chat, the previous chat **disappears** from this list
- This makes it **unsuitable for detecting archived chats** - a chat disappearing from this list doesn't mean it was archived, it just means you clicked elsewhere

**Current usage in discord-bridge**:
- ✅ Detecting **new** chats: When an ID appears that we haven't seen before
- ❌ Detecting **archived** chats: We previously used "disappeared from list" logic, but this was buggy

**Why we moved away from it for archive detection**:
```
User opens Chat A, Chat B, Chat C (all visible in list)
User clicks on Chat D
→ getOrderedSelectedComposerIds returns [D]
→ A, B, C "disappeared" but are NOT archived - just not selected
```

### `composer.openComposer`

```typescript
await vscode.commands.executeCommand('composer.openComposer', composerId);
```

**What it does**: Opens a specific composer/chat by its ID.

**Parameters**:
- `composerId` (string): The UUID of the chat to open

**Used for**: Navigating to a specific chat when delivering messages from Discord.

### `composer.focusComposer`

```typescript
await vscode.commands.executeCommand('composer.focusComposer');
```

**What it does**: Focuses the composer input field so text can be pasted.

**Used for**: Preparing to paste a Discord message into the agent chat.

## SQLite Database Storage

Cursor stores composer/chat data in an SQLite database at:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Cursor/User/workspaceStorage/{workspace-id}/state.vscdb` |
| Windows | `%APPDATA%/Cursor/User/workspaceStorage/{workspace-id}/state.vscdb` |
| Linux | `~/.config/Cursor/User/workspaceStorage/{workspace-id}/state.vscdb` |

### Finding the Workspace ID

The `workspace-id` is a hash. To find the correct folder:
1. Scan all folders in `workspaceStorage/`
2. Read `workspace.json` in each folder
3. Match against `{ "folder": "file:///path/to/workspace" }`

### Composer Data Structure

Query:
```sql
SELECT value FROM ItemTable WHERE key = 'composer.composerData';
```

Returns JSON:
```typescript
interface ComposerData {
  allComposers: ComposerHead[];
  selectedComposerIds?: string[];
  lastFocusedComposerIds?: string[];
}

interface ComposerHead {
  type: 'head';
  composerId: string;        // UUID for this chat
  name: string;              // Chat name (empty string until first message)
  subtitle?: string;
  createdAt: number;         // Unix timestamp (milliseconds)
  lastUpdatedAt: number;     // Unix timestamp (milliseconds)
  unifiedMode: string;       // 'agentic' | 'edit' | 'chat'
  isArchived: boolean;       // True if user explicitly archived
  isDraft: boolean;          // True if chat has no messages yet
}
```

### Key Fields

| Field | Description | Notes |
|-------|-------------|-------|
| `composerId` | UUID for the chat | Stable identifier |
| `name` | Chat display name | Empty string until first message is sent |
| `createdAt` | When chat was created | Milliseconds since epoch |
| `lastUpdatedAt` | Last interaction time | Used for implicit archive ranking |
| `isArchived` | Explicit archive flag | Set when user archives in Cursor |
| `isDraft` | No messages sent yet | True for new chats before first submit |

### Why Database Over Command?

We use the database for archive detection because:

1. **Immediate updates**: `isArchived` updates immediately when user archives
2. **Complete data**: Shows ALL chats, not just selected ones
3. **Additional metadata**: `lastUpdatedAt`, `isDraft`, `name` for smarter logic
4. **No false positives**: Unlike the command, a chat being absent doesn't mean archived

We still use `composer.getOrderedSelectedComposerIds` for:

1. **New chat detection**: Updates faster than database flush
2. **Combines with database**: Command finds new IDs, database confirms metadata

## Timing Considerations

### Database Flush Delay

The database isn't updated in real-time:
- New chat creation: ~100-500ms before appears in DB
- Name update: ~200-500ms after first message
- Archive flag: Nearly immediate

### Our Polling Strategy

```
Every 1 second (guarded against overlap):
1. Call getOrderedSelectedComposerIds → find new IDs immediately
2. Read database → confirm metadata, check archives
3. For new chats without names → store as "pending", wait for name
4. For archived chats → archive Discord thread
5. Every 30 polls: check for Discord auto-archived threads
```

### Poll Guard

The polling loop uses a guard to prevent overlapping iterations:

```typescript
if (this.isPolling) {
  return;  // Skip if previous poll still running
}
this.isPolling = true;
try {
  // ... async DB queries and Discord API calls
} finally {
  this.isPolling = false;
}
```

**Why this matters**: Each poll iteration involves:
- Multiple SQLite queries (~10-30ms each)
- Discord API calls (variable latency)
- Potential thread creation/archiving

Without the guard, if one iteration takes >1 second, subsequent intervals start new iterations while the previous is still running. This caused **archive thrashing**: multiple concurrent polls would both detect the same archive state changes and race to apply them, resulting in threads being archived and unarchived repeatedly.

## Version Compatibility

These APIs may not exist in all Cursor versions:

```typescript
try {
  const result = await vscode.commands.executeCommand<string[]>(
    'composer.getOrderedSelectedComposerIds'
  );
  // Use result
} catch {
  // Command doesn't exist in this version
}
```

The SQLite database structure appears stable across Cursor versions, but always handle missing data gracefully.

## Related Files

- `src/workspace/cursorStorage.ts` - Database reading utilities
- `src/workspace/chatWatcher.ts` - Polling and change detection logic
- `src/ui/messageHandler.ts` - Message delivery to agents
