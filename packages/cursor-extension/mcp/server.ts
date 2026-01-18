#!/usr/bin/env node

/**
 * Bundled MCP Server
 *
 * This is a thin proxy that receives MCP tool calls from Cursor's AI
 * and forwards them to the extension's HTTP server for processing.
 *
 * This file is bundled with the extension and its path is automatically
 * configured in ~/.cursor/mcp.json on extension activation.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';

// Debug logging to file (can't use console.log - MCP uses stdio)
const LOG_FILE = `${os.tmpdir()}/discord-bridge-mcp-debug.log`;

function debugLog(message: string) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

// Log environment on startup to help debug multi-instance routing
debugLog('=== MCP Server Starting ===');
debugLog(`cwd: ${process.cwd()}`);
debugLog(`ppid: ${process.ppid}`);
debugLog(`pid: ${process.pid}`);
debugLog(`argv: ${JSON.stringify(process.argv)}`);
debugLog(`env keys: ${Object.keys(process.env).join(', ')}`);
// Log potentially relevant env vars
for (const key of Object.keys(process.env)) {
  if (key.includes('CURSOR') || key.includes('VSCODE') || key.includes('WORKSPACE') || key.includes('CODE')) {
    debugLog(`env.${key}: ${process.env[key]}`);
  }
}
debugLog('=== End Startup Info ===');

const DEFAULT_PORT = 19876;
const PORT_RANGE_SIZE = 10; // Ports 19876-19885

// Input schemas
const PostToThreadSchema = z.object({
  message: z.string().describe('The message to post to the thread'),
  thread_id: z.string().optional().describe('Override the thread ID (uses current thread if not provided)'),
  as_embed: z.boolean().optional().default(false).describe('Format the message as a Discord embed'),
});

const SendFileToThreadSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to send'),
  file_name: z.string().optional().describe('Optional override for the filename displayed in Discord'),
  description: z.string().optional().describe('Optional message to accompany the file'),
  thread_id: z.string().optional().describe('Override the thread ID (uses current thread if not provided)'),
});

const StartTypingSchema = z.object({
  thread_id: z.string().optional().describe('Override the thread ID (uses current thread if not provided)'),
});

const StopTypingSchema = z.object({
  thread_id: z.string().optional().describe('Override the thread ID (uses current thread if not provided)'),
});

const CreateThreadSchema = z.object({
  name: z.string().describe('A short name/description for this conversation thread'),
  chat_id: z.string().optional().describe('Override the chat ID (uses current chat if not provided)'),
});

const RenameThreadSchema = z.object({
  name: z.string().describe('New name for the thread'),
  thread_id: z.string().optional().describe('Override the thread ID (uses current thread if not provided)'),
});

const CheckMessagesSchema = z.object({
  thread_id: z.string().optional().describe('Check a specific thread (uses current thread if not provided)'),
});

const ForwardUserPromptSchema = z.object({
  thread_id: z.string().describe('The thread ID to forward the prompt to'),
  prompt: z.string().describe('The user prompt text from Cursor'),
});

const AskQuestionOptionSchema = z.object({
  id: z.string().describe('Unique identifier for this option'),
  label: z.string().describe('Display label for this option'),
});

const AskQuestionSchema = z.object({
  thread_id: z.string().describe('The thread ID to post the question in'),
  question: z.string().describe('The question text to display'),
  options: z.array(AskQuestionOptionSchema).min(1).describe('Available options for the user to select'),
  allow_multiple: z.boolean().optional().default(false).describe('Allow selecting multiple options'),
  timeout_ms: z.number().optional().describe('Timeout in milliseconds (default: 5 minutes)'),
});

// Resource content for Discord workflow instructions
const DISCORD_WORKFLOW_INSTRUCTIONS = `# Discord Bridge - Agent Communication Protocol

## Overview
You are connected to a Discord bridge that allows the developer to monitor your progress and communicate with you via Discord. This enables asynchronous collaboration where the developer can check in on your work from anywhere.

## CRITICAL: Always Post Completed Work to Discord
When you complete a significant task or reach a milestone:
1. **Use \`post_to_thread\` to summarize what you accomplished**
2. Include: what was done, files changed, any issues encountered
3. This keeps the developer informed without them needing to check Cursor directly

## When to Post to Discord
- ✅ After completing a feature or fix
- ✅ When you encounter a blocker or need clarification
- ✅ When making significant architectural decisions
- ✅ At natural stopping points in your work
- ✅ When tests pass/fail on important changes
- ❌ Don't spam with every minor edit

## Message Format Suggestions
For completed work:
\`\`\`
✅ Completed: [brief description]

Changes:
- [file1]: [what changed]
- [file2]: [what changed]

[Any notes or next steps]
\`\`\`

For questions/blockers:
\`\`\`
❓ Question: [what you need]

Context: [relevant details]

Options I see:
1. [option 1]
2. [option 2]
\`\`\`

## Available Tools
- \`post_to_thread\`: Send a message to Discord (primary communication method)
- \`send_file_to_thread\`: Send screenshots, images, or files to Discord
- \`start_typing\`: Show typing indicator while processing (call at start of work)
- \`stop_typing\`: Stop the typing indicator (auto-stops when posting)
- \`check_discord_messages\`: Check for new messages from the developer
- \`create_conversation_thread\`: Create a new thread for a different topic
- \`rename_thread\`: Rename the current thread to reflect the conversation topic

## Typing Indicator Best Practice
When you receive a Discord message:
1. Call \`start_typing\` first to show you're working
2. Do your work
3. Call \`post_to_thread\` when done (typing stops automatically)

## Remember
The developer trusts you to keep them informed. Proactive communication via Discord is expected and appreciated!`;

class DiscordBridgeMCP {
  private server: Server;
  private discoveredPort: number | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'discord-bridge',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Get the workspace folder paths from the environment.
   * Cursor sets WORKSPACE_FOLDER_PATHS when spawning the MCP server.
   */
  private getExpectedWorkspaceFolders(): string[] {
    const envValue = process.env.WORKSPACE_FOLDER_PATHS;
    if (!envValue) {
      return [];
    }
    // Split on comma in case there are multiple workspace folders
    return envValue.split(',').map(p => p.trim()).filter(p => p.length > 0);
  }

  /**
   * Check if the health response's workspace folders match our expected workspace.
   */
  private workspaceMatches(healthWorkspaceFolders: string[]): boolean {
    const expected = this.getExpectedWorkspaceFolders();
    if (expected.length === 0) {
      // No workspace info from env, accept any server (fallback behavior)
      debugLog('No WORKSPACE_FOLDER_PATHS in env, accepting any server');
      return true;
    }
    
    // Check if any of our expected folders match any of the server's folders
    for (const expectedFolder of expected) {
      if (healthWorkspaceFolders.includes(expectedFolder)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Discover which port the extension is listening on.
   * Tries ports in the range DEFAULT_PORT to DEFAULT_PORT + PORT_RANGE_SIZE - 1.
   * Matches against workspace folder paths to find the correct instance.
   * Caches the result for subsequent calls.
   */
  private async discoverPort(): Promise<number> {
    // Return cached port if already discovered
    if (this.discoveredPort !== null) {
      return this.discoveredPort;
    }

    const startPort = DEFAULT_PORT;
    const endPort = DEFAULT_PORT + PORT_RANGE_SIZE;
    const expectedFolders = this.getExpectedWorkspaceFolders();
    
    debugLog(`Discovering port... Expected workspace folders: ${JSON.stringify(expectedFolders)}`);

    // First pass: look for exact workspace match
    for (let port = startPort; port < endPort; port++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(500), // 500ms timeout per port
        });
        
        if (response.ok) {
          const data = await response.json() as { 
            status?: string;
            workspaceFolders?: string[];
            workspaceName?: string;
          };
          
          if (data.status === 'ok') {
            const serverFolders = data.workspaceFolders || [];
            debugLog(`Port ${port}: status=ok, workspaceFolders=${JSON.stringify(serverFolders)}, workspaceName=${data.workspaceName}`);
            
            if (this.workspaceMatches(serverFolders)) {
              debugLog(`Port ${port}: Workspace matches! Using this port.`);
              this.discoveredPort = port;
              return port;
            } else {
              debugLog(`Port ${port}: Workspace mismatch, trying next...`);
            }
          }
        }
      } catch {
        // Port not available or not our server, try next
        continue;
      }
    }

    // If we had expected folders but found no match, give a specific error
    if (expectedFolders.length > 0) {
      throw new McpError(
        ErrorCode.InternalError,
        `Discord Bridge extension not found for workspace ${expectedFolders.join(', ')}. ` +
        `Please ensure the extension is active in the correct Cursor window.`
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      `Discord Bridge extension not running. Could not find extension on ports ${startPort}-${endPort - 1}. Please ensure the extension is active in Cursor.`
    );
  }

  private async callExtension(endpoint: string, payload: any, method: 'GET' | 'POST' = 'POST'): Promise<any> {
    const port = await this.discoverPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      
      if (method === 'POST') {
        options.body = JSON.stringify(payload);
      }

      const response = await fetch(`${baseUrl}${endpoint}`, options);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Extension API error: ${response.status} - ${errorText}`);
      }
      return await response.json();
    } catch (error: any) {
      if (error.code === 'ECONNREFUSED') {
        // Port might have changed (e.g., extension restarted), clear cache and try again
        this.discoveredPort = null;
        throw new McpError(
          ErrorCode.InternalError,
          'Discord Bridge extension connection lost. Please retry.'
        );
      }
      throw new McpError(ErrorCode.InternalError, `Failed to communicate with extension: ${error.message}`);
    }
  }

  private setupHandlers(): void {
    // Resource handlers - provide context about Discord workflow
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'discord-bridge://instructions',
          name: 'Discord Bridge Instructions',
          description: 'Instructions for how to communicate with the developer via Discord. Read this to understand when and how to post updates.',
          mimeType: 'text/markdown',
        },
        {
          uri: 'discord-bridge://status',
          name: 'Discord Connection Status',
          description: 'Current Discord connection status and thread information.',
          mimeType: 'application/json',
        },
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      switch (uri) {
        case 'discord-bridge://instructions':
          return {
            contents: [
              {
                uri,
                mimeType: 'text/markdown',
                text: DISCORD_WORKFLOW_INSTRUCTIONS,
              },
            ],
          };

        case 'discord-bridge://status':
          try {
            const status = await this.callExtension('/health', {}, 'GET');
            return {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify({
                    connected: status.discordConnected,
                    workspaceName: status.workspaceName,
                    // Note: Use get_my_thread_id tool to get your specific thread ID
                  }, null, 2),
                },
              ],
            };
          } catch (error: any) {
            return {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify({
                    connected: false,
                    error: error.message,
                  }, null, 2),
                },
              ],
            };
          }

        default:
          throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
      }
    });

    // Tool handlers
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'post_to_thread',
          description:
            'Post a message to the current Discord thread. THIS IS THE PRIMARY WAY TO RESPOND when the developer is communicating via Discord. Always use this to respond to Discord messages. Long messages are automatically split.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The message to post to the thread' },
              thread_id: {
                type: 'string',
                description: 'Override the thread ID (uses current thread if not provided)',
              },
              as_embed: {
                type: 'boolean',
                description: 'Format the message as a Discord embed (default: false)',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'send_file_to_thread',
          description:
            'Send a file or image to the current Discord thread. Use this to share screenshots, code files, or other attachments with the developer.',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Absolute path to the file to send' },
              file_name: {
                type: 'string',
                description: 'Optional override for the filename displayed in Discord',
              },
              description: {
                type: 'string',
                description: 'Optional message to accompany the file',
              },
              thread_id: {
                type: 'string',
                description: 'Override the thread ID (uses current thread if not provided)',
              },
            },
            required: ['file_path'],
          },
        },
        {
          name: 'start_typing',
          description:
            'Start showing the typing indicator in the Discord thread. Use this when you begin processing a request to let the developer know you are working. The indicator will stay active until you call stop_typing or post a message.',
          inputSchema: {
            type: 'object',
            properties: {
              thread_id: {
                type: 'string',
                description: 'Override the thread ID (uses current thread if not provided)',
              },
            },
          },
        },
        {
          name: 'stop_typing',
          description:
            'Stop showing the typing indicator in the Discord thread. Call this when you finish processing or if you need to stop the indicator for any reason.',
          inputSchema: {
            type: 'object',
            properties: {
              thread_id: {
                type: 'string',
                description: 'Override the thread ID (uses current thread if not provided)',
              },
            },
          },
        },
        {
          name: 'create_conversation_thread',
          description:
            'Create a new Discord thread for this agent conversation. Use this when starting a new conversation topic.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'A short name/description for this conversation thread',
              },
              chat_id: {
                type: 'string',
                description: 'Override the chat ID (uses current chat if not provided)',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'rename_thread',
          description:
            'Rename an existing Discord thread. Use this to give a thread a more meaningful name based on the conversation topic.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'New name for the thread',
              },
              thread_id: {
                type: 'string',
                description: 'Override the thread ID (uses current thread if not provided)',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'check_discord_messages',
          description:
            'Check for new messages from the developer in the current Discord thread. Use this to see if they sent any instructions while you were working.',
          inputSchema: {
            type: 'object',
            properties: {
              thread_id: {
                type: 'string',
                description: 'Check a specific thread (uses current thread if not provided)',
              },
            },
          },
        },
        {
          name: 'get_my_thread_id',
          description:
            'Get the Discord thread ID for your current chat session. IMPORTANT: Call this EXACTLY ONCE at the very start of your response. Store the returned thread_id and use it for ALL subsequent Discord operations (start_typing, post_to_thread, etc). NEVER call this tool again - subsequent calls will return incorrect thread IDs or hang for 5 seconds waiting for a thread that will never arrive. If you lose the thread ID, you cannot recover it.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'forward_user_prompt',
          description:
            'Forward the user\'s Cursor prompt to Discord so the developer can see what was asked. Use this ONLY when the user input came from Cursor (not Discord). You can detect this by checking if the message contains "[Discord Thread:" - if it does NOT contain this prefix, the message came from Cursor and should be forwarded. Call this immediately after getting your thread ID, before doing any work.',
          inputSchema: {
            type: 'object',
            properties: {
              thread_id: {
                type: 'string',
                description: 'The thread ID to forward the prompt to',
              },
              prompt: {
                type: 'string',
                description: 'The user prompt text from Cursor',
              },
            },
            required: ['thread_id', 'prompt'],
          },
        },
        {
          name: 'ask_question',
          description:
            'Ask a question to the Discord user and wait for their response. Use this ONLY when the most recent user message contains "[Discord Thread:" - if it does NOT contain this prefix, use the native ask_question tool instead. The question will be posted as interactive buttons in Discord, and the user can click a button or reply with text. The tool will block until the user responds or timeout (default 5 minutes).',
          inputSchema: {
            type: 'object',
            properties: {
              thread_id: {
                type: 'string',
                description: 'The thread ID to post the question in',
              },
              question: {
                type: 'string',
                description: 'The question text to display',
              },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Unique identifier for this option' },
                    label: { type: 'string', description: 'Display label for this option' },
                  },
                  required: ['id', 'label'],
                },
                description: 'Available options for the user to select',
              },
              allow_multiple: {
                type: 'boolean',
                description: 'Allow selecting multiple options (default: false)',
              },
              timeout_ms: {
                type: 'number',
                description: 'Timeout in milliseconds (default: 5 minutes)',
              },
            },
            required: ['thread_id', 'question', 'options'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'post_to_thread': {
          const parsed = PostToThreadSchema.safeParse(args);
          if (!parsed.success) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${parsed.error.message}`);
          }
          // Stop typing when posting a message
          await this.callExtension('/api/stop-typing', { threadId: parsed.data.thread_id }).catch(() => {});
          const result = await this.callExtension('/api/post-to-thread', {
            threadId: parsed.data.thread_id,
            message: parsed.data.message,
            asEmbed: parsed.data.as_embed,
          });
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error posting to thread: ${result.error}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `Message posted to thread ${result.threadId}.` }],
          };
        }

        case 'send_file_to_thread': {
          const parsed = SendFileToThreadSchema.safeParse(args);
          if (!parsed.success) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${parsed.error.message}`);
          }
          // Stop typing when sending a file
          await this.callExtension('/api/stop-typing', { threadId: parsed.data.thread_id }).catch(() => {});
          const result = await this.callExtension('/api/send-file-to-thread', {
            threadId: parsed.data.thread_id,
            filePath: parsed.data.file_path,
            fileName: parsed.data.file_name,
            description: parsed.data.description,
          });
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error sending file to thread: ${result.error}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `File sent to thread ${result.threadId}.` }],
          };
        }

        case 'start_typing': {
          const parsed = StartTypingSchema.safeParse(args);
          if (!parsed.success) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${parsed.error.message}`);
          }
          const result = await this.callExtension('/api/start-typing', {
            threadId: parsed.data.thread_id,
          });
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error starting typing: ${result.error}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: 'Typing indicator started.' }],
          };
        }

        case 'stop_typing': {
          const parsed = StopTypingSchema.safeParse(args);
          if (!parsed.success) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${parsed.error.message}`);
          }
          await this.callExtension('/api/stop-typing', {
            threadId: parsed.data.thread_id,
          });
          return {
            content: [{ type: 'text', text: 'Typing indicator stopped.' }],
          };
        }

        case 'create_conversation_thread': {
          const parsed = CreateThreadSchema.safeParse(args);
          if (!parsed.success) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${parsed.error.message}`);
          }
          const result = await this.callExtension('/api/create-thread', {
            chatId: parsed.data.chat_id,
            name: parsed.data.name,
          });
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error creating thread: ${result.error}` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: `Thread created successfully. Thread ID: ${result.threadId}, Name: ${result.threadName}`,
              },
            ],
          };
        }

        case 'rename_thread': {
          const parsed = RenameThreadSchema.safeParse(args);
          if (!parsed.success) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${parsed.error.message}`);
          }
          const result = await this.callExtension('/api/rename-thread', {
            threadId: parsed.data.thread_id,
            name: parsed.data.name,
          });
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error renaming thread: ${result.error}` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: `Thread renamed: "${result.oldName}" → "${result.newName}"`,
              },
            ],
          };
        }

        case 'check_discord_messages': {
          const parsed = CheckMessagesSchema.safeParse(args);
          if (!parsed.success) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${parsed.error.message}`);
          }
          const result = await this.callExtension('/api/check-messages', {
            threadId: parsed.data.thread_id,
          });
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error checking messages: ${result.error}` }],
              isError: true,
            };
          }
          if (!result.messages || result.messages.length === 0) {
            return {
              content: [{ type: 'text', text: 'No new messages from the developer.' }],
            };
          }
          const formattedMessages = result.messages
            .map((msg: any) => `[${new Date(msg.timestamp).toISOString()}] ${msg.author}: ${msg.content}`)
            .join('\n\n');
          return {
            content: [{ type: 'text', text: `New messages from developer:\n\n${formattedMessages}` }],
          };
        }

        case 'get_my_thread_id': {
          const result = await this.callExtension('/api/get-active-thread-id', {}, 'GET');
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Could not determine thread ID: ${result.error}. You may need to wait for a Discord user to message you first.` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `Your Discord thread ID is: ${result.threadId}\n\nIMPORTANT: Store this thread_id and use it for ALL Discord operations. Do NOT call get_my_thread_id again - it will return wrong data or hang.` }],
          };
        }

        case 'forward_user_prompt': {
          const parsed = ForwardUserPromptSchema.safeParse(args);
          if (!parsed.success) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${parsed.error.message}`);
          }
          const result = await this.callExtension('/api/forward-user-prompt', {
            threadId: parsed.data.thread_id,
            prompt: parsed.data.prompt,
          });
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error forwarding user prompt: ${result.error}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `User prompt forwarded to Discord thread ${parsed.data.thread_id}.` }],
          };
        }

        case 'ask_question': {
          const parsed = AskQuestionSchema.safeParse(args);
          if (!parsed.success) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${parsed.error.message}`);
          }
          
          // This call will block until user responds or timeout
          const result = await this.callExtension('/api/ask-question', {
            threadId: parsed.data.thread_id,
            question: parsed.data.question,
            options: parsed.data.options,
            allowMultiple: parsed.data.allow_multiple,
            timeoutMs: parsed.data.timeout_ms,
          });
          
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Question failed or timed out: ${result.error}` }],
              isError: true,
            };
          }
          
          // Format the response based on type
          if (result.responseType === 'option') {
            const selectedLabels = result.selectedOptionIds
              ?.map((id: string) => {
                const opt = parsed.data.options.find(o => o.id === id);
                return opt ? opt.label : id;
              })
              .join(', ');
            return {
              content: [{ type: 'text', text: `User selected: ${selectedLabels}` }],
            };
          } else if (result.responseType === 'text') {
            return {
              content: [{ type: 'text', text: `User responded with text: ${result.textResponse}` }],
            };
          }
          
          return {
            content: [{ type: 'text', text: 'User responded but response type unknown.' }],
          };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Discord Bridge MCP server running on stdio');
  }
}

const server = new DiscordBridgeMCP();
server.run().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
