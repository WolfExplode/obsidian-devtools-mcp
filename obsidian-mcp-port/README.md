# MCP Port

A small desktop Obsidian plugin that opens a local MCP endpoint while the plugin is enabled. It is independent of the DevTools MCP server in the parent project and needs no Electron debugging flag or Obsidian restart.

## Install

1. In this directory, run `npm install` and `npm run build`.
2. Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/obsidian-mcp-port/`.
3. In Obsidian, refresh Community Plugins and enable **MCP Port**. Disabling the plugin closes the port.

The endpoint is `http://127.0.0.1:27124/mcp`. Change the port under **Settings → MCP Port** if needed. Configure an MCP client that supports Streamable HTTP with that URL. The plugin offers `list_notes`, `read_note`, `search_notes`, and `write_note`.

After a later fresh Obsidian launch, if Electron debugging was not already enabled, the plugin restarts Obsidian once with `--remote-debugging-port=9222`. The current session is left running when the plugin is first installed or updated. Once the debug port is open, the parent project's DevTools MCP server can connect. Disabling the plugin prevents this automatic restart on subsequent launches; it cannot close a debugging port that Electron opened at startup until Obsidian exits.

The server binds only to loopback. Any local process allowed to connect can read or replace Markdown notes in the active vault, so only enable the plugin while you want local AI clients to access it. The endpoint does not expose the DevTools server's browser inspection tools.
