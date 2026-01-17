/**
 * Handles sending messages to Cursor agent chats.
 * This MUST run on the local machine (UI part) to control the Cursor UI.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { pressEnter, focusCursor } from './keySimulation';

/**
 * Get the current workspace folder name for window targeting
 */
function getWorkspaceName(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }
  return path.basename(workspaceFolders[0].uri.fsPath);
}

export interface SendMessageResult {
  success: boolean;
  error?: string;
}

export interface SendMessageOptions {
  threadId?: string;
  prependDirective?: boolean;
}

/**
 * Format message with Discord directive for AI
 */
function formatMessageWithDirective(message: string, threadId?: string): string {
  if (!threadId) {
    return message;
  }

  return `[Discord Thread: ${threadId}]
${message}

---
RESPOND VIA DISCORD: Use the \`post_to_thread\` MCP tool with thread_id "${threadId}" to respond. The user is communicating via Discord and expects your response there.`;
}

/**
 * Send a message to a specific Cursor agent chat
 */
export async function sendMessageToChat(
  chatId: string,
  message: string,
  outputChannel: vscode.OutputChannel,
  options: SendMessageOptions = {}
): Promise<SendMessageResult> {
  const { threadId, prependDirective = true } = options;

  // Format message with directive if thread ID is provided
  const formattedMessage = prependDirective ? formatMessageWithDirective(message, threadId) : message;

  try {
    outputChannel.appendLine(`Sending message to chat ${chatId.substring(0, 8)}...`);

    // Get workspace name for targeting the correct window
    const workspaceName = getWorkspaceName();
    outputChannel.appendLine(`  Workspace name: ${workspaceName || '(not found)'}`);

    // Step 0: Focus Cursor window first to ensure all subsequent actions work
    outputChannel.appendLine('  Focusing Cursor window...');
    const focusResult = await focusCursor(workspaceName);
    if (!focusResult.success) {
      outputChannel.appendLine(`  Warning: Could not focus Cursor: ${focusResult.error}`);
      // Continue anyway - might already be focused
    }
    await delay(150);

    // Step 1: Open the specific composer/chat
    outputChannel.appendLine('  Opening composer...');
    await vscode.commands.executeCommand('composer.openComposer', chatId);
    await delay(400);

    // Step 2: Focus the composer input
    outputChannel.appendLine('  Focusing composer...');
    await vscode.commands.executeCommand('composer.focusComposer');
    await delay(200);

    // Step 3: Paste the message (with directive if applicable)
    outputChannel.appendLine('  Pasting message...');
    await vscode.env.clipboard.writeText(formattedMessage);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await delay(200);

    // Step 4: Press Enter to submit (pressEnter also ensures Cursor is focused)
    outputChannel.appendLine('  Pressing Enter...');
    const enterResult = await pressEnter(workspaceName);

    if (!enterResult.success) {
      return {
        success: false,
        error: `Failed to press Enter: ${enterResult.error}`,
      };
    }

    outputChannel.appendLine('  Message sent successfully!');
    return { success: true };
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    outputChannel.appendLine(`  Error: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a message to the currently focused composer (no chat ID needed).
 * Used when we just created a new agent chat and it's already focused.
 */
export async function sendMessageToFocusedChat(
  message: string,
  outputChannel: vscode.OutputChannel
): Promise<SendMessageResult> {
  try {
    outputChannel.appendLine('Sending message to focused chat...');

    // Get workspace name for targeting the correct window
    const workspaceName = getWorkspaceName();

    // Focus the composer input (should already be focused after newAgentChat)
    outputChannel.appendLine('  Focusing composer...');
    await vscode.commands.executeCommand('composer.focusComposer');
    await delay(200);

    // Paste the message
    outputChannel.appendLine('  Pasting message...');
    await vscode.env.clipboard.writeText(message);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await delay(200);

    // Press Enter to submit
    outputChannel.appendLine('  Pressing Enter...');
    const enterResult = await pressEnter(workspaceName);

    if (!enterResult.success) {
      return {
        success: false,
        error: `Failed to press Enter: ${enterResult.error}`,
      };
    }

    outputChannel.appendLine('  Message sent successfully!');
    return { success: true };
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    outputChannel.appendLine(`  Error: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}
