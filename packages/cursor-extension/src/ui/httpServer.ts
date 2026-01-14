/**
 * HTTP server for MCP communication.
 * Runs in the UI part (local) to receive requests from the bundled MCP server.
 * Forwards Discord operations to the Workspace part via VS Code commands.
 */

import * as http from 'http';
import * as vscode from 'vscode';
import { sendMessageToChat } from './messageHandler';
import { ConfigManager } from './configManager';
import { Commands, PostToThreadParams, CreateThreadParams, SendFileToThreadParams, StartTypingParams, StopTypingParams, RenameThreadParams, ResolveThreadIdResult, ForwardUserPromptParams, AskQuestionParams, AskQuestionResult } from '../shared/commands';

const DEFAULT_PORT = 19876;

export class HttpServer {
  private server: http.Server | null = null;
  private port: number;
  private outputChannel: vscode.OutputChannel;
  private configManager: ConfigManager;

  constructor(
    port: number = DEFAULT_PORT,
    outputChannel: vscode.OutputChannel,
    configManager: ConfigManager
  ) {
    this.port = port;
    this.outputChannel = outputChannel;
    this.configManager = configManager;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (error: any) => {
        if (error.code === 'EADDRINUSE') {
          this.outputChannel.appendLine(`Port ${this.port} already in use`);
          reject(new Error(`Port ${this.port} already in use`));
        } else {
          reject(error);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.outputChannel.appendLine(`HTTP server listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.outputChannel.appendLine('HTTP server stopped');
    }
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    this.outputChannel.appendLine(`[HTTP] ${req.method} ${url.pathname}`);

    try {
      switch (url.pathname) {
        case '/health':
          await this.handleHealth(res);
          break;

        case '/api/config':
          await this.handleGetConfig(res);
          break;

        case '/api/post-to-thread':
          await this.handlePostToThread(req, res);
          break;

        case '/api/send-file-to-thread':
          await this.handleSendFileToThread(req, res);
          break;

        case '/api/start-typing':
          await this.handleStartTyping(req, res);
          break;

        case '/api/stop-typing':
          await this.handleStopTyping(req, res);
          break;

        case '/api/create-thread':
          await this.handleCreateThread(req, res);
          break;

        case '/api/rename-thread':
          await this.handleRenameThread(req, res);
          break;

        case '/api/check-messages':
          await this.handleCheckMessages(res);
          break;

        case '/api/get-active-thread-id':
          await this.handleGetActiveThreadId(res);
          break;

        case '/api/forward-user-prompt':
          await this.handleForwardUserPrompt(req, res);
          break;

        case '/api/ask-question':
          await this.handleAskQuestion(req, res);
          break;

        case '/message':
          await this.handleSendToChat(req, res);
          break;

        default:
          this.sendJson(res, 404, { error: 'Not found' });
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[HTTP] Error: ${error.message}`);
      this.sendJson(res, 500, { error: error.message });
    }
  }

  private async handleHealth(res: http.ServerResponse): Promise<void> {
    // Get Discord status from workspace part
    let discordConnected = false;
    try {
      const status = await vscode.commands.executeCommand<{ connected: boolean }>(
        Commands.GET_DISCORD_STATUS
      );
      discordConnected = status?.connected || false;
    } catch {
      // Workspace part might not be available
    }

    this.sendJson(res, 200, {
      status: 'ok',
      workspaceName: vscode.workspace.name || 'unnamed',
      discordConnected,
    });
  }

  private async handleGetConfig(res: http.ServerResponse): Promise<void> {
    const hasToken = await this.configManager.hasBotToken();
    const global = this.configManager.getGlobalConfig();
    const project = this.configManager.getProjectConfig();

    this.sendJson(res, 200, {
      hasToken,
      guildId: global?.guildId,
      channelId: project?.channelId,
    });
  }

  private async handlePostToThread(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await this.readBody(req);
    const data = JSON.parse(body) as PostToThreadParams;

    if (!data.message) {
      this.sendJson(res, 400, { error: 'Missing message' });
      return;
    }

    // Require explicit thread ID - don't fall back to getCurrentThreadId()
    // This prevents messages from going to the wrong thread in multi-agent scenarios
    // The AI should call get_my_thread_id first to get the correct thread ID
    const threadId = data.threadId;
    if (!threadId) {
      this.outputChannel.appendLine('[HTTP] post_to_thread called without thread_id');
      this.sendJson(res, 400, { error: 'No thread ID provided. Call get_my_thread_id first to get your thread ID.' });
      return;
    }

    try {
      // Forward to workspace part
      const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
        Commands.POST_TO_THREAD,
        { ...data, threadId }
      );

      if (result?.success) {
        this.sendJson(res, 200, { success: true, threadId });
      } else {
        this.sendJson(res, 500, { success: false, error: result?.error || 'Failed to post' });
      }
    } catch (error: any) {
      this.sendJson(res, 500, { success: false, error: error.message });
    }
  }

  private async handleSendFileToThread(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await this.readBody(req);
    const data = JSON.parse(body) as SendFileToThreadParams;

    if (!data.filePath) {
      this.sendJson(res, 400, { error: 'Missing filePath' });
      return;
    }

    // Require explicit thread ID - don't fall back to getCurrentThreadId()
    // This prevents files from going to the wrong thread in multi-agent scenarios
    const threadId = data.threadId;
    if (!threadId) {
      this.outputChannel.appendLine('[HTTP] send_file_to_thread called without thread_id');
      this.sendJson(res, 400, { error: 'No thread ID provided. Call get_my_thread_id first to get your thread ID.' });
      return;
    }

    try {
      // Forward to workspace part
      const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
        Commands.SEND_FILE_TO_THREAD,
        { ...data, threadId }
      );

      if (result?.success) {
        this.sendJson(res, 200, { success: true, threadId });
      } else {
        this.sendJson(res, 500, { success: false, error: result?.error || 'Failed to send file' });
      }
    } catch (error: any) {
      this.sendJson(res, 500, { success: false, error: error.message });
    }
  }

  private async handleStartTyping(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await this.readBody(req);
    const data = JSON.parse(body) as StartTypingParams;

    // Require explicit thread ID - don't fall back to getCurrentThreadId()
    // This prevents typing indicators from going to the wrong thread in multi-agent scenarios
    const threadId = data.threadId;
    if (!threadId) {
      // No thread ID means we don't know which thread to type in - silently succeed
      // The AI should call get_my_thread_id first to get the correct thread ID
      this.outputChannel.appendLine('[HTTP] start_typing called without thread_id, skipping');
      this.sendJson(res, 200, { success: true, skipped: true });
      return;
    }

    try {
      // Forward to workspace part
      const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
        Commands.START_TYPING,
        { threadId }
      );

      if (result?.success) {
        this.sendJson(res, 200, { success: true });
      } else {
        this.sendJson(res, 500, { success: false, error: result?.error || 'Failed to start typing' });
      }
    } catch (error: any) {
      this.sendJson(res, 500, { success: false, error: error.message });
    }
  }

  private async handleStopTyping(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await this.readBody(req);
    const data = JSON.parse(body) as StopTypingParams;

    // Require explicit thread ID - don't fall back to getCurrentThreadId()
    const threadId = data.threadId;
    if (!threadId) {
      // No thread ID means we don't know which thread to stop typing in - silently succeed
      this.outputChannel.appendLine('[HTTP] stop_typing called without thread_id, skipping');
      this.sendJson(res, 200, { success: true, skipped: true });
      return;
    }

    try {
      // Forward to workspace part
      await vscode.commands.executeCommand(Commands.STOP_TYPING, { threadId });
      this.sendJson(res, 200, { success: true });
    } catch (error: any) {
      this.sendJson(res, 500, { success: false, error: error.message });
    }
  }

  private async handleCreateThread(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await this.readBody(req);
    const data = JSON.parse(body) as CreateThreadParams;

    if (!data.chatId) {
      this.sendJson(res, 400, { error: 'Missing chatId' });
      return;
    }

    try {
      // Forward to workspace part
      const result = await vscode.commands.executeCommand<{ success: boolean; threadId?: string; error?: string }>(
        Commands.CREATE_THREAD,
        data
      );

      if (result?.success) {
        this.sendJson(res, 200, { success: true, threadId: result.threadId });
      } else {
        this.sendJson(res, 500, { success: false, error: result?.error || 'Failed to create thread' });
      }
    } catch (error: any) {
      this.sendJson(res, 500, { success: false, error: error.message });
    }
  }

  private async handleRenameThread(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await this.readBody(req);
    const data = JSON.parse(body) as RenameThreadParams;

    if (!data.name) {
      this.sendJson(res, 400, { error: 'Missing name' });
      return;
    }

    // Require explicit thread ID - don't fall back to getCurrentThreadId()
    const threadId = data.threadId;
    if (!threadId) {
      this.outputChannel.appendLine('[HTTP] rename_thread called without thread_id');
      this.sendJson(res, 400, { error: 'No thread ID provided. Call get_my_thread_id first to get your thread ID.' });
      return;
    }

    try {
      // Forward to workspace part
      const result = await vscode.commands.executeCommand<{ success: boolean; oldName?: string; newName?: string; error?: string }>(
        Commands.RENAME_THREAD,
        { ...data, threadId }
      );

      if (result?.success) {
        this.sendJson(res, 200, { success: true, oldName: result.oldName, newName: result.newName });
      } else {
        this.sendJson(res, 500, { success: false, error: result?.error || 'Failed to rename thread' });
      }
    } catch (error: any) {
      this.sendJson(res, 500, { success: false, error: error.message });
    }
  }

  private async handleCheckMessages(res: http.ServerResponse): Promise<void> {
    // Return empty for now - real-time messages are handled by event flow
    this.sendJson(res, 200, { success: true, messages: [] });
  }

  private async handleGetActiveThreadId(res: http.ServerResponse): Promise<void> {
    try {
      this.outputChannel.appendLine(`[HTTP] get_my_thread_id: resolving...`);

      // Find the latest unclaimed mapping and claim it
      // NOTE: This should only be called ONCE per chat session
      const result = await vscode.commands.executeCommand<ResolveThreadIdResult>(
        Commands.RESOLVE_THREAD_ID
      );

      this.outputChannel.appendLine(`[HTTP] get_my_thread_id: resolve result = ${JSON.stringify(result)}`);

      if (result?.success && result.threadId) {
        this.sendJson(res, 200, { 
          success: true, 
          threadId: result.threadId, 
          chatId: result.chatId,
          method: result.method 
        });
      } else {
        this.sendJson(res, 200, { success: false, error: result?.error || 'Could not resolve thread ID' });
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[HTTP] Error getting active thread ID: ${error.message}`);
      this.sendJson(res, 200, { success: false, error: error.message });
    }
  }

  private async handleForwardUserPrompt(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await this.readBody(req);
    const data = JSON.parse(body) as ForwardUserPromptParams;

    if (!data.threadId) {
      this.sendJson(res, 400, { error: 'Missing threadId' });
      return;
    }

    if (!data.prompt) {
      this.sendJson(res, 400, { error: 'Missing prompt' });
      return;
    }

    try {
      // Forward to workspace part
      const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
        Commands.FORWARD_USER_PROMPT,
        data
      );

      if (result?.success) {
        this.sendJson(res, 200, { success: true, threadId: data.threadId });
      } else {
        this.sendJson(res, 500, { success: false, error: result?.error || 'Failed to forward prompt' });
      }
    } catch (error: any) {
      this.sendJson(res, 500, { success: false, error: error.message });
    }
  }

  private async handleAskQuestion(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await this.readBody(req);
    const data = JSON.parse(body) as AskQuestionParams;

    if (!data.threadId) {
      this.sendJson(res, 400, { error: 'Missing threadId' });
      return;
    }

    if (!data.question) {
      this.sendJson(res, 400, { error: 'Missing question' });
      return;
    }

    if (!data.options || data.options.length === 0) {
      this.sendJson(res, 400, { error: 'Missing options' });
      return;
    }

    try {
      this.outputChannel.appendLine(`[HTTP] ask_question: forwarding to workspace part (thread: ${data.threadId})`);
      
      // Forward to workspace part - this will block until user responds or timeout
      const result = await vscode.commands.executeCommand<AskQuestionResult>(
        Commands.ASK_QUESTION,
        data
      );

      this.outputChannel.appendLine(`[HTTP] ask_question: result = ${JSON.stringify(result)}`);

      if (result?.success) {
        this.sendJson(res, 200, result);
      } else {
        this.sendJson(res, 200, { success: false, error: result?.error || 'Failed to get response' });
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[HTTP] ask_question error: ${error.message}`);
      this.sendJson(res, 500, { success: false, error: error.message });
    }
  }

  private async handleSendToChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await this.readBody(req);
    const data = JSON.parse(body) as { chatId: string; message: string; threadId?: string };

    if (!data.chatId || !data.message) {
      this.sendJson(res, 400, { error: 'Missing chatId or message' });
      return;
    }

    // This runs locally - directly call sendMessageToChat
    const result = await sendMessageToChat(data.chatId, data.message, this.outputChannel, {
      threadId: data.threadId,
      prependDirective: true,
    });

    this.sendJson(res, result.success ? 200 : 500, result);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
