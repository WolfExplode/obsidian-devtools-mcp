# Obsidian DevTools MCP Server

MCP (Model Context Protocol) server for Obsidian that enables AI-assisted plugin development via Chrome DevTools Protocol.

## Features

- **Hot reload plugins** - Reload plugins without manual toggling
- **Console log capture** - Read console logs/errors/warnings
- **Execute JavaScript** - Run arbitrary JS in Obsidian's context
- **Plugin inspection** - Query plugin state, settings, and manifests
- **Command execution** - Trigger Obsidian commands programmatically
- **Svelte store access** - Read reactive store values from plugins
- **Plugin MCP bridge** - Call MCP tools exposed by plugins (e.g., doc-doctor's dd-mcp)
- **Screenshot capture** - Capture full viewport or specific elements

## Quick Start

### 1. Build the server

```bash
npm install
npm run build
```

### 2. Launch Obsidian with debugging

```bash
./dev-obsidian.sh
```

Or manually:

```bash
# macOS
/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9222

# Linux
obsidian --remote-debugging-port=9222

# Windows
%LOCALAPPDATA%\Obsidian\Obsidian.exe --remote-debugging-port=9222
```

### 3. Register with Claude Code

```bash
claude mcp add obsidian-devtools -- node $(pwd)/dist/index.js
```

### 4. Use in Claude Code

```
Connect to Obsidian and list installed plugins.
Reload the "doc-doctor" plugin and show any console errors.
```

## Available Tools

| Tool | Description |
|------|-------------|
| `obsidian_connect` | Connect to Obsidian on specified port (default 9222) |
| `obsidian_disconnect` | Disconnect from Obsidian |
| `obsidian_reload_plugin` | Reload a plugin by ID |
| `obsidian_get_console_logs` | Get buffered console output |
| `obsidian_clear_console_logs` | Clear the log buffer |
| `obsidian_execute_js` | Run arbitrary JavaScript |
| `obsidian_get_plugin_info` | Query plugin info and manifests |
| `obsidian_list_commands` | List available commands |
| `obsidian_trigger_command` | Execute a command by ID |
| `obsidian_get_vault_info` | Get vault information |
| `obsidian_get_plugin_settings` | Read plugin settings |
| `obsidian_get_store_state` | Read Svelte store values from a plugin |
| `obsidian_call_plugin_mcp` | Call MCP tools through a plugin's embedded MCP client |
| `obsidian_capture_screenshot` | Capture screenshot of viewport or specific element |

## Architecture

```
┌─────────────────┐     stdio          ┌─────────────────────┐
│  Claude Code    │◄──────────────────►│ obsidian-devtools-  │
│  (MCP Client)   │                    │ mcp (this server)   │
└─────────────────┘                    └──────────┬──────────┘
                                                  │
                                                  │ CDP/WebSocket
                                                  ▼
                                       ┌─────────────────────┐
                                       │ Obsidian            │
                                       │ (port 9222)         │
                                       └─────────────────────┘
```

## Development Workflow

1. Start Obsidian with `./dev-obsidian.sh`
2. Start Claude Code
3. Ask Claude to connect to Obsidian
4. Develop your plugin - Claude can reload it after each build

Example workflow:
```
# In Claude Code
Connect to Obsidian.
Reload the "my-plugin" plugin and show me any errors.
Execute: console.log(app.plugins.plugins['my-plugin'].settings)
```

## Plugin MCP Bridge

The `obsidian_call_plugin_mcp` tool allows Claude Code to call MCP tools exposed by plugins that embed their own MCP client. This enables a powerful development workflow where:

1. A plugin (e.g., doc-doctor) embeds an MCP client connected to a specialized MCP server
2. Claude Code connects to Obsidian via this DevTools MCP server
3. Claude Code can call the plugin's MCP tools through the bridge

**Requirements for plugin compatibility:**
- Plugin must expose `mcpClient` property on its instance
- `mcpClient.state` must equal `'connected'`
- `mcpClient.callTool(name, args)` must be implemented

**Example with doc-doctor:**
```javascript
obsidian_call_plugin_mcp({
  pluginId: "doc-doctor",
  toolName: "analyze_document",
  arguments: {
    content: "---\ntitle: Test\nrefinement: 0.5\n---\n# Hello"
  }
})
// Returns: { properties: {...}, dimensions: {...}, warnings: [] }
```

## License

MIT
