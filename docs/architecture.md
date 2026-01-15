# Discord Bridge Architecture

This document describes the current architecture of the Discord Bridge extension, including multi-Cursor support and remote IDE compatibility.

## Component Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cursor IDE                                    │
│  ┌─────────────┐    ┌─────────────────────────────────────────────┐ │
│  │ UI Extension │◄──►│ Workspace Extension                         │ │
│  │   (local)    │    │ (local or remote)                          │ │
│  │              │    │  ┌─────────────┐  ┌────────────────────┐   │ │
│  │  - HTTP      │    │  │ ChatWatcher │  │ DiscordClientManager│   │ │
│  │    Server    │    │  │             │  │                    │   │ │
│  │  - Status    │    │  │ - Poll loop │  │ - Bot connection   │   │ │
│  │    Bar       │    │  │ - New chat  │  │ - Thread CRUD      │   │ │
│  │  - Webview   │    │  │   detection │  │ - Message send     │   │ │
│  │              │    │  └─────────────┘  └────────────────────┘   │ │
│  └──────▲───────┘    └─────────────────────────────────────────────┘ │
│         │                                                            │
└─────────┼────────────────────────────────────────────────────────────┘
          │ HTTP (localhost:19876-19885)
          │
┌─────────▼───────┐
│   MCP Server    │
│                 │
│  - Tool calls   │
│  - Port         │
│    discovery    │
│  - Workspace    │
│    matching     │
└─────────────────┘
```

## Multi-Cursor Support

### Problem

Users often run multiple Cursor windows (different projects). Each instance needs its own:
- HTTP server for MCP communication
- Discord bot connection (shared token, but separate thread mappings)

### Solution: Port Discovery with Workspace Matching

**UI Extension (HTTP Server):**
- Tries ports 19876-19885 sequentially until one is available
- Exposes `/health` endpoint that returns workspace folder paths:
  ```json
  { "status": "ok", "workspaceFolders": ["/path/to/project"] }
  ```

**MCP Server:**
- Reads `WORKSPACE_FOLDER_PATHS` environment variable (set by Cursor)
- Probes ports 19876-19885, checking each `/health` endpoint
- Matches its workspace paths against each server's response
- Caches the discovered port for subsequent calls

```typescript
// MCP server port discovery
for (let port = 19876; port < 19886; port++) {
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  const data = await health.json();
  if (workspaceMatches(data.workspaceFolders)) {
    return port;  // Found our extension!
  }
}
```

### Why Not a Single Shared Server?

Considered but rejected because:
1. Each workspace needs its own chat↔thread mappings
2. Workspace state stored in VS Code's workspaceState (per-workspace)
3. Complexity of routing requests to correct workspace context

## Remote IDE Support

### Problem

In VS Code Remote setups (SSH, Containers, WSL):
- **UI Extension** runs on local machine (has access to local files)
- **Workspace Extension** runs on remote machine (can't access local files)
- **MCP Server** spawned by Cursor, runs where the AI runs

When sending files to Discord, the file path exists only on the local machine.

### Solution: Base64 File Transfer

```
┌──────────────┐     ┌──────────────┐     ┌────────────────┐
│  MCP Server  │────►│ UI Extension │────►│Workspace Ext.  │
│              │     │   (local)    │     │   (remote)     │
│ file_path    │     │ read file    │     │ decode base64  │
│ file_name    │     │ base64 encode│     │ send to Discord│
└──────────────┘     └──────────────┘     └────────────────┘
```

**Flow:**
1. MCP tool call includes `file_path` (local path)
2. UI Extension reads file locally, encodes as base64
3. Sends `fileContentBase64` + `fileName` to Workspace Extension
4. Workspace Extension decodes and attaches to Discord message

**Interface:**
```typescript
interface SendFileToThreadParams {
  threadId: string;
  filePath?: string;           // Original path (for local-only fallback)
  fileContentBase64?: string;  // Base64-encoded file content
  fileName?: string;           // Display name for attachment
  description?: string;
}
```

## Thread Creation Flow

### Immediate Detection via selectedComposerIds

The database isn't updated immediately when a new chat is created. We use `composer.getOrderedSelectedComposerIds` for faster detection:

```
User creates new chat
        │
        ▼
getOrderedSelectedComposerIds  ◄── Updates immediately
        │
        ▼ (new ID detected)
Create thread with placeholder name "New conversation"
        │
        ▼
Database eventually flushes (100-500ms later)
        │
        ▼
NameSyncWatcher detects real name
        │
        ▼
Rename Discord thread to actual name
```

### Placeholder Naming

When agent calls `get_my_thread_id`:
1. Check if pending composer exists (detected via selectedIds)
2. Create thread immediately with "New conversation" placeholder
3. Return thread ID to agent (no waiting for DB)
4. Later: NameSyncWatcher renames when real name available

This reduces `get_my_thread_id` latency from 5-30+ seconds to <1 second.

## Polling Architecture

### Main Poll Loop (ChatWatcher)

Every 1 second (with overlap guard):

```typescript
setInterval(async () => {
  if (this.isPolling) return;  // Guard against overlap
  this.isPolling = true;
  
  try {
    // 1. Check selectedComposerIds for new chats (immediate)
    // 2. Read database for full chat list (fallback)
    // 3. Check for archived chats in DB
    // 4. Process pending composers waiting for names
    // 5. Every 30s: check for Discord auto-archived threads
  } finally {
    this.isPolling = false;
  }
}, 1000);
```

### Why the Poll Guard?

Each iteration can take >1s due to:
- Multiple SQLite queries (~10-30ms each)
- Discord API calls (variable latency)
- Thread creation (100-700ms)

Without guard: overlapping iterations cause race conditions and archive thrashing.

### Name Sync (NameSyncWatcher)

Separate watcher for thread renaming:
- Watches state.vscdb for changes (fs.watch)
- Backup poll every 30 seconds
- Compares DB names to Discord thread names
- Renames threads when they drift

## Configuration Storage

| Setting | Storage | Access |
|---------|---------|--------|
| Bot Token | VS Code SecretStorage | UI Extension only |
| Channel ID | VS Code settings (sync) | Both extensions |
| Thread Mappings | Workspace State | Workspace Extension |
| Seen Chat IDs | Workspace State | Workspace Extension |
| Archived Chat IDs | Workspace State | Workspace Extension |

## Error Handling

### Database Locked

SQLite can return "database is locked" when Cursor is writing. We:
- Catch and log the error
- Skip that poll iteration
- Retry on next poll

### Discord Rate Limits

Discord.js handles rate limits internally. Long operations (bulk archive/unarchive) may be throttled.

### Thread Not Found

Threads may be deleted or the bot may lose access. We:
- Log the error
- Mark the mapping as stale
- Skip future operations on that thread

## Files Reference

| File | Purpose |
|------|---------|
| `src/ui/httpServer.ts` | HTTP server, MCP communication |
| `src/workspace/chatWatcher.ts` | Poll loop, new chat detection |
| `src/workspace/discordClient.ts` | Discord.js wrapper, thread management |
| `src/workspace/cursorStorage.ts` | SQLite database reading |
| `src/workspace/nameSyncWatcher.ts` | Thread name synchronization |
| `mcp/server.ts` | MCP tool implementations |
