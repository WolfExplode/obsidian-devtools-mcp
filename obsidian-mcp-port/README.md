# MCP Port

A small desktop Obsidian plugin that opens a local MCP endpoint while the plugin is enabled. It is independent of the DevTools MCP server in the parent project and needs no Electron debugging flag or Obsidian restart.

## Install

The **DevTools port** setting controls the later debugging relaunch (default `9223`). If another
app owns that port, choose a free port such as `9224`, then quit Obsidian and start it normally.
Pass the same port to the DevTools server's `obsidian_connect` tool. The setting never restarts the
current session, and an explicit `--remote-debugging-port` launch flag takes precedence. It must
differ from the note MCP endpoint's **Port** setting, which defaults to `27124`.

1. In this directory, run `npm install` and `npm run build`.
2. Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/obsidian-mcp-port/`.
3. In Obsidian, refresh Community Plugins and enable **MCP Port**. Disabling the plugin closes the port.

The endpoint is `http://127.0.0.1:27124/mcp`. Change the port under **Settings → MCP Port** if needed. Configure an MCP client that supports Streamable HTTP with that URL. The plugin offers `get_selection`, `list_notes`, `read_note`, `search_notes`, and `write_note`.

Call `get_selection({})` to read the current highlighted text in one round trip. It returns compact JSON with `path` (vault-relative), `absolutePath` (when supported by the vault adapter), and `text`. Only selected text is returned, including unsaved edits; multiple editor selections are joined with a newline. Reading-mode highlights are supported too. Empty `text` means nothing is selected; `path: null` means there is no active Markdown note. The tool does not focus the editor, poll, or read the full note. After updating, reload MCP Port and refresh the client's MCP tool list.

After a later fresh Obsidian launch, if Electron debugging was not already enabled, the plugin restarts Obsidian once with the configured DevTools port. The current session is left running when the plugin is first installed or updated. Once the debug port is open, the parent project's DevTools MCP server can connect. Disabling the plugin prevents this automatic restart on subsequent launches; it cannot close a debugging port that Electron opened at startup until Obsidian exits.

The server binds only to loopback. Any local process allowed to connect can read or replace Markdown notes in the active vault, so only enable the plugin while you want local AI clients to access it. The endpoint does not expose the DevTools server's browser inspection tools.
