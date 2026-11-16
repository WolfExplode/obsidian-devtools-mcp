# PRD: Obsidian DevTools MCP Extensions

## Overview

Extend the obsidian-devtools-mcp server with advanced debugging and inspection capabilities tailored for Obsidian plugin development, with specific focus on Doc Doctor plugin workflows.

## Current State

The MCP server provides 11 tools for basic Obsidian interaction:
- Connection management (`connect`, `disconnect`)
- Console log capture (`get_console_logs`, `clear_console_logs`)
- JavaScript execution (`execute_js`)
- Plugin management (`reload_plugin`, `get_plugin_info`, `get_plugin_settings`)
- Command interaction (`list_commands`, `trigger_command`)
- Vault info (`get_vault_info`)

## Proposed Extensions

### Priority 1: High Value for Daily Development

#### 1.1 Svelte Store Inspector
**Tool**: `obsidian_get_store_state`

**Rationale**: Doc Doctor uses 15+ Svelte stores for reactive state management. Currently, inspecting store values requires manual `execute_js` calls with knowledge of store internals.

**Input Schema**:
```json
{
  "pluginId": "string (required) - Plugin ID to inspect",
  "storeName": "string (optional) - Specific store name, or omit for all",
  "modulePath": "string (optional) - Path to store module, e.g., 'stubs/stubs-store'"
}
```

**Output**: Current store value(s) serialized to JSON.

**Implementation Notes**:
- Svelte stores expose `.subscribe()` for reading
- Use `get()` from `svelte/store` for synchronous reads
- Must handle derived stores and custom store implementations
- Doc Doctor stores are in `src/stubs/stubs-store.ts`, `src/sidebar-outline/components/*/store.ts`

---

#### 1.2 MCP-to-MCP Bridge
**Tool**: `obsidian_call_plugin_mcp`

**Rationale**: Doc Doctor embeds an MCP client that communicates with `dd-mcp` (Rust binary). This tool enables calling Doc Doctor's MCP tools directly from Claude Code.

**Input Schema**:
```json
{
  "pluginId": "string (required) - Plugin with MCP client",
  "toolName": "string (required) - MCP tool name to invoke",
  "arguments": "object (optional) - Tool arguments"
}
```

**Output**: MCP tool result forwarded from plugin's MCP client.

**Implementation Notes**:
- Access via `app.plugins.plugins['doc-doctor'].mcpClient`
- MCPClient exposes `callTool(name, args)` method
- Must handle pending request state and timeouts
- Returns same structure as dd-mcp tool responses

**Available dd-mcp Tools**:
- `parse_document` - Parse frontmatter and extract L1 properties
- `analyze_document` - Calculate L2 dimensions (health, usefulness)
- `validate_document` - Check document validity
- `add_stub`, `resolve_stub`, `update_stub` - Stub manipulation
- `find_stub_anchors`, `link_stub_anchor` - Anchor operations
- `calculate_health`, `calculate_usefulness` - J-Editorial metrics

---

#### 1.3 Screenshot Capture
**Tool**: `obsidian_capture_screenshot`

**Rationale**: Visual regression testing and documentation. CDP supports `Page.captureScreenshot` which is not currently exposed.

**Input Schema**:
```json
{
  "selector": "string (optional) - CSS selector to capture, or null for full viewport",
  "format": "string (optional) - 'png' | 'jpeg' | 'webp', default 'png'",
  "quality": "number (optional) - 1-100 for jpeg/webp",
  "outputPath": "string (optional) - File path to save, or null to return base64"
}
```

**Output**: Base64-encoded image data or file path.

**Implementation Notes**:
- Requires `Page` domain in CDP (may need additional setup)
- For element screenshots: get bounding box, use `clip` parameter
- Consider `captureBeyondViewport` for full-page captures
- File writing requires Node.js `fs` module

---

### Priority 2: Enhanced Debugging

#### 2.1 Editor State Inspector
**Tool**: `obsidian_get_editor_state`

**Rationale**: Testing stub decorations, cursor navigation, and editor extensions requires knowing current editor state.

**Input Schema**:
```json
{
  "includeDecorations": "boolean (optional) - Include active decorations",
  "includeSelection": "boolean (optional) - Include selection range",
  "includeViewport": "boolean (optional) - Include visible line range"
}
```

**Output**:
```json
{
  "filePath": "string",
  "cursor": { "line": 0, "ch": 0 },
  "selection": { "anchor": {...}, "head": {...} },
  "viewport": { "from": 0, "to": 50 },
  "decorations": [{ "from": 10, "to": 20, "class": "..." }]
}
```

**Implementation Notes**:
- Access via `app.workspace.activeLeaf?.view?.editor`
- CodeMirror 6 state via `view.cm.state`
- Decorations via `view.cm.state.field(decorationField)`
- Doc Doctor decorations in `stubs-decorations.ts`

---

#### 2.2 Decoration Inspector
**Tool**: `obsidian_get_decorations`

**Rationale**: Doc Doctor applies multiple decoration types (stubs, annotations, highlights). Debugging decoration issues requires visibility into active decorations.

**Input Schema**:
```json
{
  "filter": "string (optional) - Filter by class name substring",
  "pluginId": "string (optional) - Filter by plugin source"
}
```

**Output**:
```json
{
  "decorations": [
    {
      "from": 100,
      "to": 150,
      "class": "doc-doctor-stub-expand",
      "attributes": {},
      "source": "doc-doctor"
    }
  ],
  "total": 42
}
```

**Implementation Notes**:
- Iterate `StateField` decorations in CM6
- Parse class names to identify source plugin
- Include both line and inline decorations

---

#### 2.3 LLM Debug Inspector
**Tool**: `obsidian_get_llm_debug`

**Rationale**: Doc Doctor integrates LLM providers (Anthropic, Gemini, OpenAI) for stub suggestions. Debugging requires access to request history and configuration.

**Input Schema**:
```json
{
  "pluginId": "string (required)",
  "historyLimit": "number (optional) - Max history entries, default 10"
}
```

**Output**:
```json
{
  "provider": "gemini",
  "model": "gemini-2.0-flash",
  "enabled": true,
  "history": [
    {
      "timestamp": 1234567890,
      "prompt": "...",
      "response": "...",
      "tokens": { "input": 100, "output": 200 },
      "latencyMs": 1500,
      "error": null
    }
  ],
  "cachedModels": {...}
}
```

**Implementation Notes**:
- Access via `plugin.settings.llm`
- History stored in LLMService if debug mode enabled
- Include token counts and cost estimates

---

### Priority 3: Advanced Features

#### 3.1 Hot Reload with State Preservation
**Tool**: `obsidian_hot_reload_plugin`

**Rationale**: Current `reload_plugin` loses all runtime state. State preservation enables faster iteration.

**Input Schema**:
```json
{
  "pluginId": "string (required)",
  "preserveState": "boolean (optional) - Serialize/restore state, default false",
  "stateKeys": "string[] (optional) - Specific state keys to preserve"
}
```

**Output**:
```json
{
  "status": "reloaded",
  "statePreserved": true,
  "preservedKeys": ["settings", "syncState"],
  "errors": []
}
```

**Implementation Notes**:
- Serialize stores before disable
- Store in global temp variable
- Restore after re-enable
- Handle non-serializable values gracefully

---

#### 3.2 Event Subscriber
**Tools**: `obsidian_subscribe_events`, `obsidian_get_event_log`

**Rationale**: Debug event-driven behavior by capturing Obsidian events.

**Subscribe Input**:
```json
{
  "events": ["file-open", "editor-change", "layout-change"],
  "bufferSize": 100
}
```

**Get Log Output**:
```json
{
  "events": [
    {
      "type": "file-open",
      "timestamp": 1234567890,
      "data": { "path": "..." }
    }
  ]
}
```

**Implementation Notes**:
- Use `app.workspace.on()`, `app.vault.on()` for subscriptions
- Store event handlers in connection state
- Clean up on disconnect

---

#### 3.3 Smart Connections Inspector
**Tool**: `obsidian_get_related_notes`

**Rationale**: Doc Doctor integrates with Smart Connections for semantic search. Direct query access aids debugging.

**Input Schema**:
```json
{
  "path": "string (required) - File path to find relations for",
  "limit": "number (optional) - Max results, default 10",
  "threshold": "number (optional) - Min similarity, default 0.2"
}
```

**Output**:
```json
{
  "source": "path/to/file.md",
  "related": [
    {
      "path": "other/file.md",
      "similarity": 0.85,
      "excerpt": "..."
    }
  ],
  "embeddingsStatus": {
    "total": 4695,
    "indexed": 4690
  }
}
```

**Implementation Notes**:
- Access via `app.plugins.plugins['smart-connections']`
- Use `find_relevant` or similar API
- Check for plugin availability first

---

#### 3.4 Performance Profiler
**Tools**: `obsidian_start_profiling`, `obsidian_stop_profiling`

**Rationale**: Measure render performance, store update frequency, and memory usage.

**Start Input**:
```json
{
  "categories": ["rendering", "memory", "stores"],
  "sampleInterval": 100
}
```

**Stop Output**:
```json
{
  "duration": 5000,
  "samples": 50,
  "metrics": {
    "rendering": {
      "frameCount": 300,
      "avgFrameTime": 16.5,
      "maxFrameTime": 45
    },
    "memory": {
      "heapUsed": { "start": 50, "end": 55, "peak": 60 }
    }
  }
}
```

**Implementation Notes**:
- Use `Performance` API for timing
- Use CDP `HeapProfiler` domain for memory
- Store samples in connection state

---

## Implementation Order

| Phase | Tools | Complexity | Value |
|-------|-------|------------|-------|
| 1 | `get_store_state`, `call_plugin_mcp`, `capture_screenshot` | Medium | High |
| 2 | `get_editor_state`, `get_decorations`, `get_llm_debug` | Medium | Medium |
| 3 | `hot_reload_plugin` (enhanced), `subscribe_events`, `get_event_log` | High | Medium |
| 4 | `get_related_notes`, `start_profiling`, `stop_profiling` | High | Low |

## Technical Considerations

### CDP Domains Required
- `Runtime` (current) - JavaScript evaluation
- `Page` (new) - Screenshots
- `HeapProfiler` (new) - Memory profiling
- `Performance` (new) - Rendering metrics

### State Management
New tools require additional connection state:
```typescript
interface ConnectionState {
  // Existing
  client: CDP.Client | null;
  consoleLogs: ConsoleEntry[];

  // New
  eventSubscriptions: Map<string, EventHandler>;
  eventLog: EventEntry[];
  profilingSession: ProfilingSession | null;
}
```

### Error Handling
All new tools should:
1. Check connection state before execution
2. Validate plugin existence for plugin-specific tools
3. Return structured errors with actionable messages
4. Handle non-serializable values gracefully

## Success Metrics

1. **Svelte Store Inspector**: Can read all Doc Doctor stores without manual code
2. **MCP Bridge**: Can call `analyze_document` and get health scores directly
3. **Screenshot**: Can capture explore panel for visual comparison
4. **Editor State**: Can verify cursor position after stub navigation

## References

- [Doc Doctor Stubs Store](../doc-doctor/src/stubs/stubs-store.ts)
- [Doc Doctor MCP Client](../doc-doctor/src/mcp/mcp-client.ts)
- [CDP Protocol Docs](https://chromedevtools.github.io/devtools-protocol/)
- [MCP Specification](https://modelcontextprotocol.io/)
