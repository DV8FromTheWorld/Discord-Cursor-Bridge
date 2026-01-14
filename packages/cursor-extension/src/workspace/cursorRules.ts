/**
 * Manages Cursor rules file for Discord Bridge workflow instructions.
 * Creates/updates .cursor/rules/discord-bridge.mdc to ensure the AI
 * always knows to communicate via Discord.
 */

import * as vscode from 'vscode';
import * as path from 'path';

const RULES_DIR = '.cursor/rules';
const RULES_FILE = 'discord-bridge.mdc';

// Increment this when RULES_CONTENT changes to trigger updates in existing workspaces
const RULES_VERSION = '8';

const RULES_CONTENT = `---
version: ${RULES_VERSION}
description: Discord Bridge - Mirror all responses to Discord
globs: []
alwaysApply: true
---

# Discord Bridge - Response Mirroring

You are connected to a Discord bridge. The developer monitors your work via Discord and expects to see your responses there.

## CRITICAL: Forward Cursor Prompts to Discord

**If the user's message does NOT contain \`[Discord Thread:\`, you MUST forward it to Discord using \`mcp_discord-bridge_forward_user_prompt\`.**

- Messages from Discord contain \`[Discord Thread:\` - do NOT forward these
- Messages from Cursor do NOT contain this prefix - MUST forward these

**Call \`mcp_discord-bridge_forward_user_prompt\` immediately after getting your thread ID, BEFORE starting typing or doing any work. This is NOT optional.**

## CRITICAL: Mirror Your COMPLETE Responses to Discord

**After every response you give, post the FULL content to Discord using \`mcp_discord-bridge_post_to_thread\`.**

This creates a mirrored experience where the developer can follow along in Discord without needing to be in Cursor. **Do NOT summarize or shorten your responses for Discord.** The developer should receive the exact same information in both places.

### How to Mirror (IMPORTANT: Get Thread ID First!)

**At the very start of your response**, call \`mcp_discord-bridge_get_my_thread_id\` EXACTLY ONCE to get your Discord thread ID. Store this ID and use it for ALL Discord operations:

1. Call \`mcp_discord-bridge_get_my_thread_id\` → returns your thread_id (CALL ONLY ONCE!)
2. Check if message contains \`[Discord Thread:\` - if NO, call \`mcp_discord-bridge_forward_user_prompt\`
3. Call \`mcp_discord-bridge_start_typing\` with the thread_id to show you're working
4. Do your work
5. Call \`mcp_discord-bridge_post_to_thread\` with the thread_id and your FULL response

**IMPORTANT: Forward the prompt BEFORE starting typing.** Sending a message stops the typing indicator, so forwarding must come first.

**CRITICAL: NEVER call get_my_thread_id more than once per chat session.** Subsequent calls will return wrong thread IDs or hang for 5 seconds waiting for a thread that will never arrive. Store the thread_id and reuse it for the entire conversation.

**Why this matters:** There may be multiple AI agents running in parallel. Each agent claims a unique thread ID on first call. Calling again would claim a different thread.

### Forward Cursor Prompts to Discord (CRITICAL)

**You MUST forward user prompts that come from Cursor to Discord.** The developer monitors via Discord and needs to see what was asked.

**How to detect message origin:**
- Messages from **Discord** contain \`[Discord Thread:\` at the start
- Messages from **Cursor** do NOT contain this prefix

**RULE: If the user's message does NOT start with \`[Discord Thread:\`, you MUST call \`mcp_discord-bridge_forward_user_prompt\` immediately after getting your thread ID, BEFORE doing any work.**

This is NOT optional. Without forwarding, the developer has no context about what you're working on.

### What to Post
- ✅ Your complete answers and explanations (NOT summarized)
- ✅ All code changes you made (full content, not summarized)
- ✅ Questions you're asking
- ✅ Status updates and progress
- ✅ Errors or blockers encountered
- ✅ Screenshots using \`mcp_discord-bridge_send_file_to_thread\`

### Discord Markdown Limitations

Discord supports a subset of markdown. When mirroring content:

**Supported in Discord:**
- Code blocks with triple backticks (including syntax highlighting)
- Bold, italic, strikethrough, underline
- Bullet lists and numbered lists
- Links
- Block quotes

**NOT supported in Discord (must be converted or omitted):**
- ❌ Tables - convert to plain text lists or formatted text
- ❌ Mermaid diagrams in code blocks - describe in text or omit the diagram
- ❌ Complex nested markdown structures

### Discord Newline Behavior (IMPORTANT)

Discord handles newlines differently than standard markdown:
- **Single newline = line break** in Discord (no need for double newlines)
- **Double newlines = extra blank line** (creates excessive whitespace)

When writing for Discord:
- Use single newlines between lines/paragraphs
- Only use double newlines when you intentionally want extra spacing
- This is the opposite of standard markdown where you need double newlines for paragraphs

### Handling Long Responses

Discord messages have a 2000 character limit. **Do NOT summarize to fit this limit.** Instead:

1. The tool will automatically split long messages at reasonable boundaries
2. Send the complete content and let it split into multiple messages
3. For very long code blocks, the tool handles splitting appropriately

### What NOT to Do
- ❌ Do NOT summarize long responses for Discord
- ❌ Do NOT shorten code examples
- ❌ Do NOT omit details that appear in Cursor
- ❌ Do NOT use tables in Discord messages (convert to lists)
- ❌ Do NOT include mermaid code blocks (describe in text instead)

## Available Tools

**mcp_discord-bridge_get_my_thread_id** - Get your Discord thread ID (call ONCE at start, NEVER again!)
**mcp_discord-bridge_forward_user_prompt** - Forward user's Cursor prompt to Discord (when message lacks [Discord Thread:] prefix)
**mcp_discord-bridge_post_to_thread** - Post your FULL response to Discord (every response)
**mcp_discord-bridge_send_file_to_thread** - Send screenshots, images, or files to Discord
**mcp_discord-bridge_start_typing** - Show typing indicator when starting work (pass thread_id!)
**mcp_discord-bridge_stop_typing** - Stop typing indicator (auto-stops on post)
**mcp_discord-bridge_check_discord_messages** - Check if the developer sent new instructions via Discord
**mcp_discord-bridge_create_conversation_thread** - Create a new thread for a different topic
**mcp_discord-bridge_rename_thread** - Rename the current thread to give it a more meaningful name
**mcp_discord-bridge_ask_question** - Ask a question with button options (use INSTEAD of native ask_question for Discord users)

## Asking Questions to Discord Users

When you need to ask a question to the user and the message contains \`[Discord Thread:\` (indicating they're on Discord):

**DO NOT use the native \`ask_question\` tool.** Discord users cannot interact with Cursor's native question UI.

**Instead, use \`mcp_discord-bridge_ask_question\`:**
- Posts the question to Discord with interactive buttons
- User can click a button OR reply with text
- Tool blocks until user responds (or 5 minute timeout)
- Returns the selected option(s) or text response

Example:
\`\`\`
mcp_discord-bridge_ask_question({
  thread_id: "your_thread_id",
  question: "Which approach should I use?",
  options: [
    { id: "option_a", label: "Use existing helper function" },
    { id: "option_b", label: "Create new abstraction" }
  ]
})
\`\`\`

The user will see buttons in Discord and can either click one or type a custom response.

## Remember

The developer is following along in Discord. **Every response should be mirrored there in FULL.** The Discord message should contain the same complete information as what appears in Cursor. This is your primary communication channel with them.
`;

export async function ensureCursorRulesExist(outputChannel: vscode.OutputChannel): Promise<boolean> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    outputChannel.appendLine('No workspace folder found, skipping cursor rules creation');
    return false;
  }

  const workspaceRoot = workspaceFolders[0].uri;
  const rulesDir = vscode.Uri.joinPath(workspaceRoot, RULES_DIR);
  const rulesFile = vscode.Uri.joinPath(rulesDir, RULES_FILE);

  try {
    // Check if rules file already exists and if it needs updating
    let needsUpdate = false;
    let isNewFile = false;
    
    try {
      const existingContent = await vscode.workspace.fs.readFile(rulesFile);
      const existingText = new TextDecoder().decode(existingContent);
      
      // Check if the file has the current version
      const versionMatch = existingText.match(/^version:\s*(\d+)/m);
      const existingVersion = versionMatch ? versionMatch[1] : '0';
      
      if (existingVersion !== RULES_VERSION) {
        outputChannel.appendLine(`Cursor rules file outdated (v${existingVersion} → v${RULES_VERSION}), updating...`);
        needsUpdate = true;
      } else {
        outputChannel.appendLine('Cursor rules file is up to date');
        return false;
      }
    } catch {
      // File doesn't exist, we'll create it
      isNewFile = true;
      needsUpdate = true;
    }

    if (!needsUpdate) {
      return false;
    }

    // Ensure .cursor/rules directory exists
    try {
      await vscode.workspace.fs.createDirectory(rulesDir);
    } catch {
      // Directory might already exist, that's fine
    }

    // Write the rules file
    const content = new TextEncoder().encode(RULES_CONTENT);
    await vscode.workspace.fs.writeFile(rulesFile, content);
    
    if (isNewFile) {
      outputChannel.appendLine(`Created cursor rules file: ${path.join(RULES_DIR, RULES_FILE)}`);
      vscode.window.showInformationMessage(
        'Discord Bridge: Created .cursor/rules/discord-bridge.mdc - AI will now auto-post to Discord'
      );
    } else {
      outputChannel.appendLine(`Updated cursor rules file to v${RULES_VERSION}`);
      vscode.window.showInformationMessage(
        `Discord Bridge: Updated .cursor/rules/discord-bridge.mdc to v${RULES_VERSION}`
      );
    }
    
    return true;
  } catch (error: any) {
    outputChannel.appendLine(`Failed to create/update cursor rules: ${error.message}`);
    return false;
  }
}

export async function removeCursorRules(outputChannel: vscode.OutputChannel): Promise<boolean> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return false;
  }

  const workspaceRoot = workspaceFolders[0].uri;
  const rulesFile = vscode.Uri.joinPath(workspaceRoot, RULES_DIR, RULES_FILE);

  try {
    await vscode.workspace.fs.delete(rulesFile);
    outputChannel.appendLine('Removed cursor rules file');
    return true;
  } catch {
    // File might not exist, that's fine
    return false;
  }
}
