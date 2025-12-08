#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { writeFile } from 'fs/promises';
import { obsidian } from './connection.js';

const server = new Server(
  { name: 'obsidian-devtools-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Tool definitions
const tools = [
  {
    name: 'obsidian_connect',
    description:
      'Connect to a running Obsidian instance with remote debugging enabled. Must be called before using other obsidian_* tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        port: {
          type: 'number',
          description: 'CDP port (default: 9222)',
          default: 9222,
        },
      },
    },
  },
  {
    name: 'obsidian_disconnect',
    description: 'Disconnect from Obsidian.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'obsidian_reload_plugin',
    description: 'Reload a plugin by disabling and re-enabling it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pluginId: {
          type: 'string',
          description: 'The plugin ID to reload (e.g., "doc-doctor")',
        },
      },
      required: ['pluginId'],
    },
  },
  {
    name: 'obsidian_get_console_logs',
    description: 'Retrieve recent console output from Obsidian.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        level: {
          type: 'string',
          enum: ['log', 'warn', 'error', 'info', 'debug', 'all'],
          description: 'Filter by log level (default: all)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of entries to return',
        },
        since: {
          type: 'number',
          description: 'Only return logs after this timestamp (ms)',
        },
        clear: {
          type: 'boolean',
          description: 'Clear the log buffer after reading',
        },
      },
    },
  },
  {
    name: 'obsidian_clear_console_logs',
    description: 'Clear the buffered console logs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'obsidian_execute_js',
    description:
      'Execute arbitrary JavaScript in Obsidian\'s renderer context. Has access to `app`, `window`, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code to execute',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'obsidian_get_plugin_info',
    description: 'Get information about installed plugins.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pluginId: {
          type: 'string',
          description: 'Specific plugin ID (omit for all plugins)',
        },
      },
    },
  },
  {
    name: 'obsidian_list_commands',
    description: 'List available commands from Obsidian\'s command palette.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filter: {
          type: 'string',
          description: 'Filter commands by name (case-insensitive substring match)',
        },
      },
    },
  },
  {
    name: 'obsidian_trigger_command',
    description: 'Execute an Obsidian command by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        commandId: {
          type: 'string',
          description: 'The command ID to execute',
        },
      },
      required: ['commandId'],
    },
  },
  {
    name: 'obsidian_get_vault_info',
    description: 'Get current vault information.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'obsidian_get_plugin_settings',
    description: 'Read a plugin\'s saved settings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pluginId: {
          type: 'string',
          description: 'The plugin ID to get settings for',
        },
      },
      required: ['pluginId'],
    },
  },
  {
    name: 'obsidian_get_store_state',
    description:
      'Read Svelte store values from a plugin. Returns current state of reactive stores.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pluginId: {
          type: 'string',
          description: 'Plugin ID (e.g., "doc-doctor")',
        },
        storeName: {
          type: 'string',
          description:
            'Specific store name (e.g., "syncState"), or omit for all known stores',
        },
      },
      required: ['pluginId'],
    },
  },
  {
    name: 'obsidian_call_plugin_mcp',
    description:
      "Call an MCP tool through a plugin's embedded MCP client (e.g., doc-doctor's dd-mcp tools).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        pluginId: {
          type: 'string',
          description: 'Plugin ID with MCP client',
        },
        toolName: {
          type: 'string',
          description:
            'MCP tool name (e.g., "analyze_document", "parse_document")',
        },
        arguments: {
          type: 'object',
          description: 'Tool arguments as key-value pairs',
        },
      },
      required: ['pluginId', 'toolName'],
    },
  },
  {
    name: 'obsidian_capture_screenshot',
    description: 'Capture a screenshot of Obsidian window or a specific element.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for element (omit for full viewport)',
        },
        format: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description: 'Image format (default: png)',
        },
        quality: {
          type: 'number',
          description: 'Quality 1-100 for jpeg/webp',
        },
        outputPath: {
          type: 'string',
          description: 'File path to save image (omit to return base64)',
        },
      },
    },
  },
];

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'obsidian_connect': {
        const port = (args?.port as number) ?? 9222;
        const info = await obsidian.connect(port);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'connected',
                  obsidian: info,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'obsidian_disconnect': {
        await obsidian.disconnect();
        return {
          content: [{ type: 'text', text: 'Disconnected from Obsidian' }],
        };
      }

      case 'obsidian_reload_plugin': {
        const pluginId = args?.pluginId as string;
        if (!pluginId) {
          throw new Error('pluginId is required');
        }

        // Capture logs before reload
        const beforeTimestamp = Date.now();

        await obsidian.evaluate(`
          (async () => {
            const id = ${JSON.stringify(pluginId)};
            if (!app.plugins.manifests[id]) {
              throw new Error('Plugin not found: ' + id);
            }
            await app.plugins.disablePlugin(id);
            await app.plugins.enablePlugin(id);
          })()
        `);

        // Wait a bit for any async operations
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Get any errors that occurred during reload
        const reloadLogs = obsidian.getConsoleLogs({
          since: beforeTimestamp,
          level: 'error',
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'reloaded',
                  pluginId,
                  errors: reloadLogs.map((l) => l.message),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'obsidian_get_console_logs': {
        const logs = obsidian.getConsoleLogs({
          level: args?.level as 'log' | 'warn' | 'error' | 'info' | 'debug' | 'all',
          limit: args?.limit as number,
          since: args?.since as number,
          clear: args?.clear as boolean,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                logs.map((l) => ({
                  time: new Date(l.timestamp).toISOString(),
                  level: l.level,
                  message: l.message,
                })),
                null,
                2
              ),
            },
          ],
        };
      }

      case 'obsidian_clear_console_logs': {
        obsidian.clearConsoleLogs();
        return {
          content: [{ type: 'text', text: 'Console logs cleared' }],
        };
      }

      case 'obsidian_execute_js': {
        const code = args?.code as string;
        if (!code) {
          throw new Error('code is required');
        }

        const result = await obsidian.evaluate(code);
        return {
          content: [
            {
              type: 'text',
              text:
                typeof result === 'string'
                  ? result
                  : JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'obsidian_get_plugin_info': {
        const pluginId = args?.pluginId as string | undefined;

        const result = await obsidian.evaluate(`
          (function() {
            const plugins = app.plugins.plugins;
            const manifests = app.plugins.manifests;
            const enabled = Array.from(app.plugins.enabledPlugins || []);

            if (${pluginId ? `true` : `false`}) {
              const id = ${JSON.stringify(pluginId)};
              const manifest = manifests[id];
              if (!manifest) return { error: 'Plugin not found: ' + id };
              return {
                id,
                manifest,
                enabled: enabled.includes(id),
                loaded: !!plugins[id]
              };
            }

            return Object.keys(manifests).map(id => ({
              id,
              name: manifests[id].name,
              version: manifests[id].version,
              enabled: enabled.includes(id),
              loaded: !!plugins[id]
            }));
          })()
        `);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'obsidian_list_commands': {
        const filter = args?.filter as string | undefined;

        const result = await obsidian.evaluate(`
          (function() {
            const commands = app.commands.commands;
            const filter = ${filter ? JSON.stringify(filter.toLowerCase()) : 'null'};

            return Object.values(commands)
              .filter(cmd => !filter || cmd.name.toLowerCase().includes(filter))
              .map(cmd => ({
                id: cmd.id,
                name: cmd.name
              }))
              .sort((a, b) => a.name.localeCompare(b.name));
          })()
        `);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'obsidian_trigger_command': {
        const commandId = args?.commandId as string;
        if (!commandId) {
          throw new Error('commandId is required');
        }

        const result = await obsidian.evaluate(`
          (function() {
            const cmd = app.commands.commands[${JSON.stringify(commandId)}];
            if (!cmd) {
              return { success: false, error: 'Command not found: ' + ${JSON.stringify(commandId)} };
            }
            app.commands.executeCommandById(${JSON.stringify(commandId)});
            return { success: true, commandId: ${JSON.stringify(commandId)}, name: cmd.name };
          })()
        `);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'obsidian_get_vault_info': {
        const result = await obsidian.evaluate(`
          (function() {
            const vault = app.vault;
            const files = vault.getFiles();
            const folders = vault.getAllLoadedFiles().filter(f => f.children !== undefined);

            return {
              name: vault.getName(),
              path: vault.adapter.basePath,
              fileCount: files.length,
              folderCount: folders.length,
              pluginFolder: vault.configDir + '/plugins'
            };
          })()
        `);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'obsidian_get_plugin_settings': {
        const pluginId = args?.pluginId as string;
        if (!pluginId) {
          throw new Error('pluginId is required');
        }

        const result = await obsidian.evaluate(`
          (function() {
            const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
            if (!plugin) {
              return { error: 'Plugin not loaded: ' + ${JSON.stringify(pluginId)} };
            }
            return plugin.settings || {};
          })()
        `);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'obsidian_get_store_state': {
        const pluginId = args?.pluginId as string;
        const storeName = args?.storeName as string | undefined;

        if (!pluginId) {
          throw new Error('pluginId is required');
        }

        const result = await obsidian.evaluate(`
          (function() {
            const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
            if (!plugin) {
              return { error: 'Plugin not loaded: ' + ${JSON.stringify(pluginId)} };
            }

            // Doc Doctor specific store access
            if (${JSON.stringify(pluginId)} === 'doc-doctor') {
              const stores = {};

              // Known store names in doc-doctor
              const storeNames = ['syncState', 'stubsConfig', 'selectedStubId', 'filterText',
                                 'expandedTypes', 'hiddenTypes', 'isLoading', 'errorMessage'];

              // Check if plugin exposes stores
              if (plugin.stubsStore) {
                for (const name of storeNames) {
                  if (plugin.stubsStore[name]) {
                    try {
                      // Svelte stores have subscribe method, use get pattern
                      let value;
                      plugin.stubsStore[name].subscribe(v => value = v)();
                      stores[name] = value;
                    } catch (e) {
                      stores[name] = { error: e.message };
                    }
                  }
                }
              }

              // Check for outline state
              if (plugin.outlineState) {
                stores['outlineState'] = plugin.outlineState;
              }

              // Check for MCP client state
              if (plugin.mcpClient) {
                stores['mcpClient'] = {
                  state: plugin.mcpClient.state,
                  toolCount: plugin.mcpClient.tools?.length || 0
                };
              }

              // Settings indicator
              stores['settings'] = plugin.settings ? 'available (use get_plugin_settings)' : 'not found';

              ${storeName ? `return stores[${JSON.stringify(storeName)}] || { error: 'Store not found' };` : 'return stores;'}
            }

            // Generic plugin - return what we can find
            return {
              availableKeys: Object.keys(plugin).filter(k => !k.startsWith('_')),
              hint: 'Use obsidian_execute_js to access specific stores'
            };
          })()
        `);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'obsidian_call_plugin_mcp': {
        const pluginId = args?.pluginId as string;
        const toolName = args?.toolName as string;
        const toolArgs = (args?.arguments as Record<string, unknown>) || {};

        if (!pluginId) throw new Error('pluginId is required');
        if (!toolName) throw new Error('toolName is required');

        const result = await obsidian.evaluate(`
          (async function() {
            const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
            if (!plugin) {
              return { error: 'Plugin not loaded: ' + ${JSON.stringify(pluginId)} };
            }

            const mcpClient = plugin.mcpClient;
            if (!mcpClient) {
              return { error: 'Plugin does not have an MCP client' };
            }

            if (mcpClient.state !== 'connected') {
              return { error: 'MCP client not connected. State: ' + mcpClient.state };
            }

            try {
              const result = await mcpClient.callTool(
                ${JSON.stringify(toolName)},
                ${JSON.stringify(toolArgs)}
              );
              return result;
            } catch (e) {
              return { error: e.message, stack: e.stack };
            }
          })()
        `);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'obsidian_capture_screenshot': {
        const selector = args?.selector as string | undefined;
        const format = (args?.format as 'png' | 'jpeg' | 'webp') || 'png';
        const quality = args?.quality as number | undefined;
        const outputPath = args?.outputPath as string | undefined;

        const base64Data = await obsidian.captureScreenshot({
          selector,
          format,
          quality,
        });

        if (outputPath) {
          const buffer = Buffer.from(base64Data, 'base64');
          await writeFile(outputPath, buffer);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { saved: outputPath, size: buffer.length, format },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  format,
                  dataLength: base64Data.length,
                  data:
                    base64Data.substring(0, 100) +
                    '... (truncated, use outputPath to save full image)',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Obsidian DevTools MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
