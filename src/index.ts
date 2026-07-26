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
    name: 'obsidian_list_targets',
    description: 'List renderer targets visible through CDP, including Obsidian Popouts and transparent windows.',
    inputSchema: { type: 'object' as const, properties: { port: { type: 'number', default: 9222 } } },
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
    name: 'obsidian_install_probe',
    description:
      'Install a named disposable event probe in Obsidian. The installer must be a JavaScript function expression receiving emit(data), and must return a disposer function. Events are buffered in the renderer until read or removal.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Probe identifier (letters, numbers, _, ., :, -)' },
        installer: {
          type: 'string',
          description:
            'JavaScript function expression, e.g. (emit) => { const ref = app.vault.on("modify", f => emit({path:f.path})); return () => app.vault.offref(ref); }',
        },
        maxEvents: { type: 'number', description: 'Maximum buffered events (default 500, maximum 10000)' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['id', 'installer'],
    },
  },
  {
    name: 'obsidian_read_probe',
    description: 'Read buffered events from a named renderer probe, optionally filtering by timestamp and limiting or clearing the buffer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Probe identifier' },
        since: { type: 'number', description: 'Only events at or after this Unix timestamp in milliseconds' },
        limit: { type: 'number', description: 'Return only the most recent N events' },
        clear: { type: 'boolean', description: 'Clear the probe buffer after reading' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['id'],
    },
  },
  {
    name: 'obsidian_remove_probe',
    description: 'Dispose and remove a named renderer probe.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Probe identifier' }, targetId: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'obsidian_list_probes',
    description: 'List installed renderer probes and their buffered event counts.',
    inputSchema: { type: 'object' as const, properties: { targetId: { type: 'string' } } },
  },
  {
    name: 'obsidian_execute_js',
    description:
      'Execute arbitrary JavaScript in Obsidian\'s RENDERER context. Has access to `app`, `window`, etc. Note: reaching MAIN-process state from here goes through `@electron/remote`, whose proxy forwards function calls but NOT property writes/deletes — so mutating main-process objects (e.g. `delete require.cache[...]`) silently no-ops. Use obsidian_execute_js_main for that.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code to execute',
        },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['code'],
    },
  },
  {
    name: 'obsidian_execute_js_main',
    description:
      "Execute JavaScript in Electron's MAIN process (via @electron/remote's vm.runInThisContext) and return its JSON-serialized result. Use this when you must MUTATE main-process state — deleting a require.cache entry, tweaking a BrowserWindow, inspecting main-only globals — which obsidian_execute_js cannot do (the remote proxy drops property writes/deletes). `code` is an expression (wrap statements in an IIFE); a main-bound `require` is in scope. Synchronous: a returned Promise is NOT awaited.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript expression to evaluate in the main process (e.g. `(() => { delete require.cache[require.resolve(p)]; return Object.keys(require.cache).length; })()`)',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'obsidian_wait_for_condition',
    description: 'Poll a JavaScript predicate in a selected renderer until it returns a truthy value or times out.',
    inputSchema: { type: 'object' as const, properties: {
      predicate: { type: 'string', description: 'JavaScript function expression or expression, e.g. () => !!document.querySelector(".excalidraw")' },
      timeoutMs: { type: 'number', default: 5000 }, intervalMs: { type: 'number', default: 100 }, targetId: { type: 'string' },
    }, required: ['predicate'] },
  },
  {
    name: 'obsidian_get_native_windows',
    description: 'Inspect Electron BrowserWindow instances, bounds, focus, always-on-top state, and webContents metadata.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'obsidian_get_excalidraw_state',
    description: 'Inspect live Excalidraw scenes and compare them with the parsed persisted scene for each matching leaf.',
    inputSchema: { type: 'object' as const, properties: { file: { type: 'string' }, targetId: { type: 'string' } } },
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
    name: 'obsidian_list_leaves',
    description:
      'List every open workspace leaf (view) across all windows, including popout windows. ' +
      'For each: viewType, file path, which window it lives in (main vs popout#N — the key ' +
      'signal when debugging popouts, which are separate JS realms), whether it is the active ' +
      'leaf, and hasExcalidrawApi (whether the Excalidraw imperative API has mounted). ' +
      'Saves hand-writing an iterateAllLeaves snippet in obsidian_execute_js.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        viewType: {
          type: 'string',
          description:
            'Optional case-insensitive substring filter on viewType (e.g. "excalidraw", "markdown").',
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
    name: 'obsidian_get_plugin_diagnostics',
    description: 'Read a plugin-provided structured diagnostic snapshot, including lifecycle state and bounded event history when available.',
    inputSchema: { type: 'object' as const, properties: { pluginId: { type: 'string', description: 'Plugin ID' }, since: { type: 'number', description: 'Only return events at or after this timestamp' } }, required: ['pluginId'] },
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
        targetId: { type: 'string', description: 'CDP target ID; omit for the main renderer' },
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

      case 'obsidian_list_targets': {
        const result = await obsidian.listTargets((args?.port as number) ?? 9222);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

      case 'obsidian_install_probe': {
        const id = args?.id as string;
        const installer = args?.installer as string;
        if (!id) throw new Error('id is required');
        if (!installer) throw new Error('installer is required');
        const result = await obsidian.installProbe(id, installer, args?.maxEvents as number | undefined, args?.targetId as string | undefined);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'obsidian_read_probe': {
        const id = args?.id as string;
        if (!id) throw new Error('id is required');
        const result = await obsidian.readProbe(id, {
          since: args?.since as number | undefined,
          limit: args?.limit as number | undefined,
          clear: args?.clear as boolean | undefined,
        }, args?.targetId as string | undefined);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'obsidian_remove_probe': {
        const id = args?.id as string;
        if (!id) throw new Error('id is required');
        const result = await obsidian.removeProbe(id, args?.targetId as string | undefined);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'obsidian_list_probes': {
        const result = await obsidian.listProbes(args?.targetId as string | undefined);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'obsidian_execute_js': {
        const code = args?.code as string;
        if (!code) {
          throw new Error('code is required');
        }

        const result = await obsidian.evaluateInTarget(code, args?.targetId as string | undefined);
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

      case 'obsidian_execute_js_main': {
        const code = args?.code as string;
        if (!code) {
          throw new Error('code is required');
        }

        const result = await obsidian.evaluateMain(code);
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

      case 'obsidian_wait_for_condition': {
        const predicate = args?.predicate as string;
        if (!predicate) throw new Error('predicate is required');
        const result = await obsidian.waitFor(
          predicate,
          (args?.timeoutMs as number) ?? 5000,
          (args?.intervalMs as number) ?? 100,
          args?.targetId as string | undefined,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'obsidian_get_native_windows': {
        const result = await obsidian.evaluateMain(`(() => {
          const { BrowserWindow } = require('electron');
          return BrowserWindow.getAllWindows().map((win) => ({
            id: win.id,
            title: win.getTitle(),
            url: (() => { try { return win.webContents.getURL(); } catch (_) { return null; } })(),
            focused: win.isFocused(),
            destroyed: win.isDestroyed(),
            bounds: win.getBounds(),
            alwaysOnTop: win.isAlwaysOnTop(),
            webContentsId: win.webContents?.id ?? null,
            devToolsOpened: win.webContents?.isDevToolsOpened?.() ?? false,
          }));
        })()`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'obsidian_get_excalidraw_state': {
        const file = args?.file as string | undefined;
        const result = await obsidian.evaluateInTarget(`(() => {
          const wanted = ${JSON.stringify(file ?? null)};
          const safeElement = (el) => ({
            id: el.id, type: el.type, x: el.x, y: el.y, width: el.width, height: el.height,
            angle: el.angle, fileId: el.fileId ?? null, crop: el.crop ?? null,
            scale: el.scale ?? null, customData: el.customData ?? null,
            isDeleted: !!el.isDeleted,
          });
          const rows = [];
          app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view;
            if (!view?.excalidrawAPI) return;
            const path = view.file?.path ?? null;
            if (wanted && path !== wanted) return;
            const live = view.excalidrawAPI.getSceneElements?.() ?? [];
            const persisted = view.excalidrawData?.scene?.elements ?? [];
            const liveFiles = view.excalidrawAPI.getFiles?.() ?? {};
            const persistedFiles = view.excalidrawData?.files ?? {};
            const liveById = Object.fromEntries(live.map(safeElement).map(e => [e.id, e]));
            const persistedById = Object.fromEntries(persisted.map(safeElement).map(e => [e.id, e]));
            const ids = [...new Set([...Object.keys(liveById), ...Object.keys(persistedById)])];
            const differences = ids.filter(id => JSON.stringify(liveById[id] ?? null) !== JSON.stringify(persistedById[id] ?? null));
            rows.push({ path, viewType: view.getViewType?.() ?? null, liveElementCount: live.length,
              persistedElementCount: persisted.length, liveFileIds: Object.keys(liveFiles),
              persistedFileIds: Object.keys(persistedFiles), differences,
              elements: { live: live.map(safeElement), persisted: persisted.map(safeElement) } });
          });
          return rows;
        })()`, args?.targetId as string | undefined);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

      case 'obsidian_list_leaves': {
        const viewType = args?.viewType as string | undefined;

        const result = await obsidian.evaluate(`
          (function() {
            const mainDoc = document;
            const popoutDocs = [];
            const filter = ${viewType ? JSON.stringify(viewType.toLowerCase()) : 'null'};
            const rows = [];
            app.workspace.iterateAllLeaves(leaf => {
              const view = leaf.view || {};
              const type = view.getViewType ? view.getViewType() : null;
              // Map each leaf's owning document to a window label. Popout windows
              // are separate documents (and separate JS realms) from the main one.
              const doc = view.containerEl ? view.containerEl.ownerDocument : null;
              let windowLabel = 'main';
              if (doc && doc !== mainDoc) {
                let idx = popoutDocs.indexOf(doc);
                if (idx === -1) { idx = popoutDocs.length; popoutDocs.push(doc); }
                windowLabel = 'popout' + (idx + 1);
              }
              rows.push({
                viewType: type,
                file: view.file ? view.file.path : null,
                window: windowLabel,
                active: app.workspace.activeLeaf === leaf,
                hasExcalidrawApi: !!view.excalidrawAPI,
              });
            });
            return rows.filter(r => !filter || (r.viewType || '').toLowerCase().includes(filter));
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

      case 'obsidian_get_plugin_diagnostics': {
        const pluginId = args?.pluginId as string;
        if (!pluginId) throw new Error('pluginId is required');
        const since = args?.since as number | undefined;
        const result = await obsidian.evaluate(`(() => {
          const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
          if (!plugin) return { error: 'Plugin not loaded: ' + ${JSON.stringify(pluginId)} };
          if (typeof plugin.getDiagnostics !== 'function') return {
            supported: false,
            availableKeys: Object.keys(plugin).filter(k => !k.startsWith('_')),
          };
          const value = plugin.getDiagnostics();
          if (${since == null ? 'false' : 'true'} && Array.isArray(value?.events)) {
            value.events = value.events.filter(e => e.timestamp >= ${Math.floor(since ?? 0)});
          }
          return { supported: true, value };
        })()`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
          targetId: args?.targetId as string | undefined,
        } as any);

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
