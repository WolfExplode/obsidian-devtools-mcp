# Obsidian DevTools MCP Server

MCP (Model Context Protocol) server for Obsidian that enables AI-assisted plugin development via Chrome DevTools Protocol.

## Features

- **Hot reload plugins** - Reload plugins without manual toggling
- **Multi-window inspection** - Inspect and evaluate Popout and transparent-window renderer targets
- **Console log capture** - Read console logs/errors/warnings
- **Persistent runtime probes** - Install named, disposable listeners with bounded event buffers
- **Per-frame sampling** - Sample an expression every animation frame, to observe rendering while a *user* performs a gesture
- **Canvas measurement** - Size, opaque-pixel count, coverage and content hash for every canvas matching a selector
- **Render-state awareness** - Readings are flagged when the renderer isn't painting, and frames can be forced on demand
- **Condition waiting** - Wait for real renderer readiness predicates with timeout diagnostics
- **Excalidraw diagnostics** - Compare live scene state with the persisted scene and embedded file map
- **Excalidraw snapshot/restore** - Capture a scene verbatim before a destructive experiment, and restore it exactly
- **Electron window inspection** - Inspect native BrowserWindow bounds, focus, and always-on-top state
- **Execute JavaScript** - Run arbitrary JS in Obsidian's renderer, or in the Electron main process (`obsidian_execute_js_main`)
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

### Tool discovery and profiles

To avoid putting every specialised schema into the AI context for every turn,
the server starts with the **core** toolset (14 routine plugin-development
tools). Ask it to use `obsidian_discover_tools` when the task is unclear; it
returns the appropriate toolset and the agent can call `obsidian_set_toolset`.
Compatible MCP clients refresh their tool list automatically. If yours does
not, reconnect after changing the toolset.

| Toolset | Use for |
|---|---|
| `core` (default) | Connect/reload, console errors, renderer JS, commands, plugin and vault inspection |
| `diagnostics` | Probes, Excalidraw reports, popouts, Electron windows, screenshots, and plugin diagnostics |
| `full` | Every tool, including main-process JS, stores, and embedded plugin-MCP calls |

Start with another default by setting `OBSIDIAN_MCP_TOOLSET` to `core`,
`diagnostics`, or `full` in the MCP server environment. The toolset is scoped
to that running server process.

Example:

```text
Use obsidian_discover_tools for "debug an Excalidraw popout", then enable the recommended toolset.
```

The complete catalog, shown below, is available through these toolsets.

### Concise responses by default

Inspection tools favor small, decision-ready responses: console reads return at
most 50 recent messages without stack traces, event and timeline reads default
to 50 entries, command lists default to 50 commands, and plugin settings,
stores, diagnostics, plugin-MCP results, and Excalidraw state return summaries.
Pass `detail: "full"` when a tool supports it, or raise its `limit` only for the
specific evidence you need. All tool text is compact JSON and has a 12,000
character final safety cap.

For maintainers, profile membership and task matching live in
[`src/tool-registry.ts`](src/tool-registry.ts); add or reclassify a tool there
instead of duplicating its discovery rules in the request handler.

| Tool | Description |
|------|-------------|
| `obsidian_discover_tools` | Recommend the right toolset for a development task |
| `obsidian_set_toolset` | Switch the visible toolset and notify compatible clients |
| `obsidian_connect` | Connect to Obsidian on specified port (default 9222) |
| `obsidian_disconnect` | Disconnect from Obsidian |
| `obsidian_list_targets` | List CDP renderer targets, including Popouts |
| `obsidian_reload_plugin` | Reload a plugin by ID |
| `obsidian_get_console_logs` | Get buffered console output and compact stack traces when available |
| `obsidian_clear_console_logs` | Clear the log buffer |
| `obsidian_install_probe` | Install a named disposable renderer listener/probe, with optional raw-payload preservation and coalescing |
| `obsidian_read_probe` | Read/filter/clear buffered probe events, optionally including preserved raw payload JSON |
| `obsidian_watch_excalidraw` | Watch an Excalidraw scene and report coalesced element, file, and app-state deltas |
| `obsidian_start_excalidraw_bug_window` | Begin a bounded capture of an Excalidraw reproduction |
| `obsidian_finish_excalidraw_bug_window` | Finish a capture and return scene, console, and persistence evidence in one report |
| `obsidian_get_diagnostic_timeline` | Merge probe events, grouped console logs, and plugin diagnostic events by time |
| `obsidian_remove_probe` | Dispose and remove a probe |
| `obsidian_list_probes` | List installed probes and buffer sizes |
| `obsidian_execute_js` | Run arbitrary JavaScript in the **renderer** |
| `obsidian_execute_js_main` | Run JavaScript in the Electron **main process** (mutate `require.cache`, BrowserWindows, main-only globals) |
| `obsidian_wait_for_condition` | Wait for a renderer predicate to become true |
| `obsidian_get_plugin_info` | Query plugin info and manifests |
| `obsidian_list_commands` | List available commands |
| `obsidian_trigger_command` | Execute a command by ID |
| `obsidian_get_vault_info` | Get vault information |
| `obsidian_get_plugin_settings` | Read plugin settings |
| `obsidian_get_plugin_diagnostics` | Read structured plugin lifecycle diagnostics |
| `obsidian_get_store_state` | Read Svelte store values from a plugin |
| `obsidian_call_plugin_mcp` | Call MCP tools through a plugin's embedded MCP client |
| `obsidian_capture_screenshot` | Capture screenshot of viewport or specific element |
| `obsidian_get_native_windows` | Inspect native Electron windows |
| `obsidian_get_excalidraw_state` | Compare live and persisted Excalidraw state |

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

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | MCP protocol wiring: tool schemas and handlers |
| `src/connection.ts` | CDP transport, evaluation, console capture, probes, screenshots |
| `src/renderer-scripts.ts` | JavaScript shipped *into* the page (canvas helpers, per-frame sampler) |
| `src/scene-snapshot.ts` | Excalidraw scene capture/restore, disk-backed |
| `src/tool-registry.ts` | Toolset taxonomy and discovery |

`renderer-scripts.ts` and `scene-snapshot.ts` are separate modules so `verify/live.mjs`
can exercise them without booting the server on stdio.

## Development Workflow

1. Start Obsidian with `./dev-obsidian.sh`
2. Start Claude Code
3. Ask Claude to connect to Obsidian
4. Develop your plugin - Claude can reload it after each build

### Verifying the server

This server is almost entirely I/O against a live Electron app, so unit tests
would mostly assert that string templates are unchanged. `npm run verify` instead
builds and then exercises the real CDP path against a running Obsidian, asserting
on real renderer behaviour — including that a hidden window's rAF really is
paused and that `pumpFrames` really restarts it.

```bash
npm run verify                    # read-only checks
npm run verify -- --destructive   # also mutates and restores an open Excalidraw board
```

The destructive group is opt-in because it damages an open board on purpose (it
moves elements, deletes one, and rewrites z-order) to prove the snapshot/restore
round trip actually recovers it.

Example workflow:
```
# In Claude Code
Connect to Obsidian.
Reload the "my-plugin" plugin and show me any errors.
Execute: console.log(app.plugins.plugins['my-plugin'].settings)
```

### Runtime probes

For timing-sensitive behavior, install a probe once, reproduce the behavior
manually, then read and remove it. The installer is a JavaScript function that
receives `emit(data)` and returns a disposer. Events are JSON-sanitized and kept
in a bounded ring buffer, so the probe does not depend on console timing.

```javascript
obsidian_install_probe({
  id: "vault-modifies",
  installer: `(emit) => {
    const ref = app.vault.on("modify", file => emit({ path: file.path }));
    return () => app.vault.offref(ref);
  }`,
  maxEvents: 200
})

obsidian_read_probe({ id: "vault-modifies", clear: true })
obsidian_remove_probe({ id: "vault-modifies" })
```

For a scene or method trace, the installer can wrap an object method and emit a
stack or selected fields before calling the original method. Keep probes
read-only when investigating live user workflows, and always remove them when
the test is complete.

### A hidden window is not painting (read this before measuring pixels)

**When Obsidian is not the foreground window, `document.visibilityState` is
`"hidden"` and the renderer stops firing `requestAnimationFrame` entirely.**
Since an agent driving Obsidian over CDP is essentially never the focused window,
this is the normal case, not an edge case. Two consequences, both silent:

- Any feature built on a rAF loop is **frozen**, so `getImageData` through
  `obsidian_execute_js` returns whatever was painted last — a stale bitmap with no
  indication that it is stale.
- `obsidian_capture_screenshot` **forces a frame**, so a screenshot of that same
  instant looks completely correct. The two tools disagree.

This combination once cost an afternoon: an overlay read an identical pixel count
in every state and a debug hook reported "loop running, nothing painted", all of
which pointed at a plugin bug that did not exist.

The server now handles it three ways:

- `obsidian_connect` reports `render` up front, with a warning when hidden.
- `obsidian_execute_js` and `obsidian_canvas_probe` attach a warning to any
  reading taken while the renderer is paused.
- Both accept `pumpFrames: n`, which forces `n` frames — running the paused rAF
  callbacks — before reading, so pixel assertions against a background window are
  valid rather than quietly wrong.

```javascript
obsidian_canvas_probe({ selector: ".excalidraw canvas", pumpFrames: 2 })
// → per-canvas bitmap size, opaquePixels, coveragePercent, hash
```

### Watching rendering during a real gesture

Scripted input is the wrong tool for "does this render correctly *while* the user
drags something" — a synthetic drag can appear to work while exercising a
different code path (pointer-event coalescing alone will mislead you). Use the
same listener discipline as event probes, at frame resolution: install the
sampler, ask the user to perform the gesture, then read the buffer.

```javascript
obsidian_watch_frames({
  id: "overlay-during-drag",
  expression: `({ overlay: $canvas(".my-overlay")[0]?.hash, zoom: $render().visibility })`
})
// ...user drags an element...
obsidian_read_probe({ id: "overlay-during-drag" })
obsidian_remove_probe({ id: "overlay-during-drag" })
```

Helpers in scope: `$canvas(selector)`, `$pixel(selector, x, y)`, `$render()`.
Consecutive identical samples coalesce, which is what makes "did this change
during the gesture" readable at a glance. Nothing is sampled while the window is
hidden — correctly, since that is also when the feature under test isn't
rendering.

### Snapshot a scene before breaking it

Excalidraw derives z-order from a fractional `index` property, not from array
position. So reordering the elements array and writing it back appears to do
nothing, while writing back objects whose `index` was already rewritten silently
reorders the board — and both failure modes look identical from outside. Take a
snapshot before any destructive experiment on a real vault:

```javascript
obsidian_excalidraw_snapshot({})            // → { token, elementCount, bytes }
// ...mutate freely...
obsidian_excalidraw_restore({ token })      // → { orderMatches: true, ... }
```

Elements are stored verbatim, `index` included, so a restore is exact rather than
approximate. The payload is written to disk, so it survives an MCP or renderer
restart, and `restore` reports whether ids actually came back in the captured
order instead of assuming the write worked.

### Excalidraw bug windows

For a manual reproduction, use a bug window instead of assembling a watcher,
console query, and state snapshots yourself. Starting a window records a compact
baseline and installs a coalesced scene listener. Finishing it removes that
listener by default and returns the baseline and final scene summaries plus one
timestamp-sorted timeline of scene and console evidence. It does not clear the
shared console buffer. Use `detail: "sources"` for separate scene and console
arrays, or `detail: "summary"` for counts only.

```javascript
obsidian_start_excalidraw_bug_window({ file: "WIP/diagram.md" })
// Reproduce the problem in Obsidian.
obsidian_finish_excalidraw_bug_window({ id: "bug-window:..." })
```

The scene summaries include live-versus-persisted element differences and flag
zero-sized or file-backed elements whose live file entry is missing. Pass
`keepOpen: true` when you want to capture another reproduction with the same
window.

Excalidraw watchers and bug windows use compact noise control by default. Rapid
updates to the same element become one action with `callbacks`, `durationMs`,
and before/after geometry; selection and zoom-only callbacks become compact
`ui-noise` runs. Use `obsidian_watch_excalidraw({ noise: "all", ... })` only
when callback-level timing is important.

## Renderer vs. main process (important)

`obsidian_execute_js` evaluates in Obsidian's **renderer** (the CDP target is the page). `app`, `window`, and the DOM live there. To touch the Electron **main process** from the renderer you go through `@electron/remote` — and its proxy has a sharp edge:

> **`@electron/remote` forwards function _calls_ to main, but NOT property _writes_ or _deletes_.**

So `delete remote.require('module')._cache[key]` (or any assignment to a main-process object) is a **silent no-op** — it mutates the local proxy, never the real object in main. Reads through the proxy can also return stale/snapshotted views, so verifying a mutation by reading it back through `remote` gives false results. Verify **functionally** instead (change a value, reload, read it back).

When you need to actually mutate main-process state — bust a `require.cache` entry so a main-process module (e.g. a plugin's `.cjs` helper loaded via `remote.require`) hot-reloads, tweak a `BrowserWindow`, read a main-only global — use **`obsidian_execute_js_main`**. It compiles your code and runs it *in* the main process via `remote.require('vm').runInThisContext`, where deletes and assignments take effect. It returns a JSON-serialized value; a main-bound `require` is in scope; execution is synchronous (a returned Promise is not awaited).

```javascript
// No-op via the proxy from the renderer:
obsidian_execute_js({ code: `(() => { delete require('@electron/remote').require('module')._cache['X']; })()` })

// Actually clears it, in main:
obsidian_execute_js_main({ code: `(() => { delete require.cache['X']; return !require.cache['X']; })()` })
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
