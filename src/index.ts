#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { writeFile } from 'fs/promises';
import { obsidian, type ConsoleEntry, type RenderState } from './connection.js';
import { CANVAS_HELPERS_JS, frameWatcherInstaller } from './renderer-scripts.js';
import { captureSceneSnapshot, restoreSceneSnapshot } from './scene-snapshot.js';
import { ToolRegistry, type Toolset } from './tool-registry.js';

// MCP responses become model context. Keep ordinary diagnostic responses useful
// but bounded; callers can still use execute_js to request a deliberately
// narrower or paginated view of very large data.
// Tool results are injected into model context. This is a final safety net;
// individual tools should still choose small, useful defaults.
const MAX_TOOL_OUTPUT_CHARS = 12_000;
function toolText(value: unknown): string {
  let raw: string;
  if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value) ?? 'null';
    } catch (error) {
      raw = JSON.stringify({
        serializationError: error instanceof Error ? error.message : String(error),
        value: String(value),
      });
    }
  }
  if (raw.length <= MAX_TOOL_OUTPUT_CHARS) return raw;

  const renderTruncated = (preview: string) => JSON.stringify({
    truncated: true,
    originalChars: raw.length,
    previewChars: preview.length,
    hint: 'Use filters, since, limit, file, storeName, or execute_js to request a narrower result.',
    preview,
  });

  // JSON escaping can make the envelope larger than the raw preview. Shrink
  // until the complete MCP text payload, rather than just its data field, fits.
  let previewLength = Math.min(raw.length, MAX_TOOL_OUTPUT_CHARS);
  let text = renderTruncated(raw.slice(0, previewLength));
  while (text.length > MAX_TOOL_OUTPUT_CHARS && previewLength > 0) {
    previewLength = Math.max(0, previewLength - (text.length - MAX_TOOL_OUTPUT_CHARS));
    text = renderTruncated(raw.slice(0, previewLength));
  }
  return text;
}

type Detail = 'summary' | 'full';

function detailOf(args: Record<string, unknown> | undefined): Detail {
  return args?.detail === 'full' ? 'full' : 'summary';
}

/** A bounded structural preview for opaque plugin and JavaScript values. */
function summarizeValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return value.length <= 500 ? value : { type: 'string', length: value.length, preview: value.slice(0, 500) };
  }
  if (typeof value !== 'object') return String(value);
  if (depth >= 2) return Array.isArray(value)
    ? { type: 'array', count: value.length }
    : { type: 'object', keys: Object.keys(value as object).slice(0, 20) };
  if (Array.isArray(value)) {
    return { type: 'array', count: value.length, sample: value.slice(0, 10).map((item) => summarizeValue(item, depth + 1)) };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return {
    type: 'object',
    keyCount: keys.length,
    value: Object.fromEntries(keys.slice(0, 20).map((key) => [key, summarizeValue(record[key], depth + 1)])),
    ...(keys.length > 20 ? { omittedKeys: keys.length - 20 } : {}),
  };
}

const server = new Server(
  { name: 'obsidian-devtools-mcp', version: '1.0.0' },
  // The tool list can be expanded on demand. Clients that support this
  // notification refresh their schemas after obsidian_set_toolset is called.
  { capabilities: { tools: { listChanged: true } } }
);

type BugWindow = {
  id: string;
  file: string;
  startedAt: number;
  targetId?: string;
  baseline: unknown;
  consoleCounts: Map<string, number>;
};

// Bug windows intentionally live only for the MCP process lifetime. They are
// disposable diagnostic sessions, not user data or durable application state.
const bugWindows = new Map<string, BugWindow>();

function consoleKey(log: ConsoleEntry): string {
  return JSON.stringify([log.targetId, log.level, log.message, log.stackTrace]);
}

function excalidrawWatcherInstaller(file: string, noise: 'compact' | 'all' = 'compact'): string {
  return `(emit) => {
    const path = ${JSON.stringify(file)};
    const noise = ${JSON.stringify(noise)};
    const leaf = app.workspace.getLeavesOfType('excalidraw').find(l => l.view?.file?.path === path);
    const api = leaf?.view?.excalidrawAPI;
    if (!api) throw new Error('Active Excalidraw API unavailable for ' + path);
    let previous;
    let pending = null;
    const DEBOUNCE_MS = 250;
    const flush = () => {
      if (!pending) return;
      clearTimeout(pending.timer);
      emit(pending.event, pending.original);
      pending = null;
    };
    const enqueue = (key, event, original) => {
      if (noise === 'all') { emit(event, original); return; }
      if (pending?.key === key) {
        pending.event.callbacks += 1;
        pending.event.durationMs = Date.now() - pending.startedAt;
        if (event.after) pending.event.after = event.after;
        if (event.selectedCount != null) {
          pending.event.selectedCountRange[0] = Math.min(pending.event.selectedCountRange[0], event.selectedCount);
          pending.event.selectedCountRange[1] = Math.max(pending.event.selectedCountRange[1], event.selectedCount);
        }
        if (event.zoom != null) {
          pending.event.zoomRange[0] = Math.min(pending.event.zoomRange[0], event.zoom);
          pending.event.zoomRange[1] = Math.max(pending.event.zoomRange[1], event.zoom);
        }
        clearTimeout(pending.timer);
        pending.timer = setTimeout(flush, DEBOUNCE_MS);
        return;
      }
      flush();
      const startedAt = Date.now();
      pending = { key, startedAt, original, event: { ...event, callbacks: 1, durationMs: 0,
        selectedCountRange: [event.selectedCount ?? 0, event.selectedCount ?? 0],
        zoomRange: [event.zoom ?? 0, event.zoom ?? 0] }, timer: setTimeout(flush, DEBOUNCE_MS) };
    };
    const snapshot = (elements, appState, files) => {
      const active = (elements || []).filter(e => !e.isDeleted);
      const fingerprints = Object.fromEntries(active.map(e => [e.id, [e.version, e.versionNonce, e.type, e.x, e.y, e.width, e.height, e.fileId || null].join(':')]));
      const details = Object.fromEntries(active.map(e => [e.id, { type: e.type, x: e.x, y: e.y, width: e.width, height: e.height, angle: e.angle, fileId: e.fileId || null }]));
      return {
        elementCount: active.length,
        deletedCount: (elements || []).length - active.length,
        fileCount: files ? Object.keys(files).length : 0,
        fingerprints, details,
        selectedCount: Object.values(appState?.selectedElementIds || {}).filter(Boolean).length,
        tool: appState?.activeTool?.type || null,
        zoom: appState?.zoom?.value || null,
      };
    };
    // Excalidraw's onChange callback is not an initial-state subscription: its
    // first invocation follows a mutation. Seed the comparison from the live
    // API now so that first user action is reported as a real delta rather than
    // being mislabeled and discarded as a baseline.
    previous = snapshot(
      api.getSceneElements?.() ?? [],
      api.getAppState?.() ?? {},
      api.getFiles?.() ?? {},
    );
    const unsubscribe = api.onChange((elements, appState, files) => {
      const current = snapshot(elements, appState, files);
      const before = previous?.fingerprints || {};
      const after = current.fingerprints;
      const added = Object.keys(after).filter(id => !(id in before));
      const removed = Object.keys(before).filter(id => !(id in after));
      const changed = Object.keys(after).filter(id => id in before && before[id] !== after[id]);
      if (!previous) {
        emit({ kind: 'scene-baseline', path,
          elementCount: current.elementCount, deletedCount: current.deletedCount, fileCount: current.fileCount,
          selectedCount: current.selectedCount, tool: current.tool, zoom: current.zoom }, { path, elements, appState, files });
      } else if (added.length || removed.length || changed.length || current.fileCount !== previous.fileCount) {
        const ids = [...added, ...removed, ...changed].sort();
        const before = Object.fromEntries(ids.map(id => [id, previous.details[id] ?? null]));
        const after = Object.fromEntries(ids.map(id => [id, current.details[id] ?? null]));
        const kind = added.length || removed.length ? 'scene-structure' : 'element-update';
        enqueue(kind + ':' + ids.join(','), {
          kind, path,
          elementCount: current.elementCount, deletedCount: current.deletedCount, fileCount: current.fileCount,
          fileDelta: current.fileCount - previous.fileCount,
          elementsAdded: added, elementsRemoved: removed, elementsChanged: changed,
          before, after, selectedCount: current.selectedCount, tool: current.tool, zoom: current.zoom,
        }, { path, elements, appState, files });
      } else {
        enqueue('ui:' + current.tool, {
          kind: 'ui-noise', path, action: current.tool,
          selectedCount: current.selectedCount, zoom: current.zoom,
        }, { path, elements, appState, files });
      }
      previous = current;
    });
    const dispose = () => { flush(); unsubscribe?.(); };
    // Let the probe host flush the debounce queue before it snapshots events.
    // Without this, finishing a bug window immediately after an interaction can
    // read the buffer before its final compacted action has been emitted.
    dispose.flush = flush;
    return dispose;
  }`;
}


async function getExcalidrawSceneSummary(file: string, targetId?: string): Promise<unknown> {
  return obsidian.evaluateInTarget(`(() => {
    const path = ${JSON.stringify(file)};
    const leaf = app.workspace.getLeavesOfType('excalidraw').find(l => l.view?.file?.path === path);
    const view = leaf?.view;
    if (!view?.excalidrawAPI) return { path, available: false, reason: 'Active Excalidraw API unavailable' };
    const live = view.excalidrawAPI.getSceneElements?.() ?? [];
    const persisted = view.excalidrawData?.scene?.elements ?? [];
    const files = view.excalidrawAPI.getFiles?.() ?? {};
    const active = elements => elements.filter(e => !e.isDeleted);
    const byType = elements => Object.fromEntries(Object.entries(elements.reduce((counts, e) => {
      counts[e.type] = (counts[e.type] || 0) + 1; return counts;
    }, {})).sort(([a], [b]) => a.localeCompare(b)));
    const fingerprint = e => JSON.stringify([e.type, e.version, e.x, e.y, e.width, e.height, e.angle, e.fileId || null, e.crop || null, !!e.isDeleted]);
    const liveById = Object.fromEntries(live.map(e => [e.id, fingerprint(e)]));
    const persistedById = Object.fromEntries(persisted.map(e => [e.id, fingerprint(e)]));
    const ids = [...new Set([...Object.keys(liveById), ...Object.keys(persistedById)])];
    const differences = ids.filter(id => liveById[id] !== persistedById[id]);
    const badElements = active(live).filter(e => e.width <= 0 || e.height <= 0 || (e.fileId && !files[e.fileId]))
      .slice(0, 50).map(e => ({ id: e.id, type: e.type, width: e.width, height: e.height, fileId: e.fileId || null,
        issue: e.width <= 0 || e.height <= 0 ? 'non-positive-dimension' : 'missing-live-file' }));
    return {
      path, available: true,
      live: { elementCount: live.length, activeElementCount: active(live).length, elementTypes: byType(active(live)), fileCount: Object.keys(files).length },
      persisted: { elementCount: persisted.length, activeElementCount: active(persisted).length, elementTypes: byType(active(persisted)), fileCount: Object.keys(view.excalidrawData?.files ?? {}).length },
      persistence: { differenceCount: differences.length, differenceIds: differences.slice(0, 100), truncated: differences.length > 100 },
      suspiciousElements: badElements,
    };
  })()`, targetId);
}

/**
 * The warning attached to any result that may have been read from a renderer
 * that isn't painting. Returns null when the window is visible, so a healthy
 * session sees no extra noise — the point is to speak up only in the case that
 * silently produces wrong readings.
 */
function renderWarning(render: RenderState | undefined): string | null {
  if (!render?.rafPaused) return null;
  return (
    `Obsidian is ${render.visibility} (focused: ${render.hasFocus}), so the renderer is NOT firing ` +
    'requestAnimationFrame. Anything driven by a rAF loop is frozen, and canvas pixels read here may ' +
    'be a stale bitmap — while obsidian_capture_screenshot forces a frame and would look correct at ' +
    'this same instant. Pass pumpFrames (e.g. 2) to force frames before reading, or have the user ' +
    'focus the Obsidian window.'
  );
}


// Tool definitions
const allTools = [
  {
    name: 'obsidian_discover_tools',
    description:
      'Recommend a toolset for an Obsidian task. Call this before improvising a workaround: the default ' +
      '"core" toolset only covers connect/reload/console/commands/vault/settings/renderer-JS. Probes, ' +
      'screenshots, Excalidraw scene state, popout/window inspection, and main-process JS live in the ' +
      '"diagnostics" and "full" toolsets and are invisible until obsidian_set_toolset reveals them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Optional task, e.g. "debug Excalidraw" or "inspect a popout"' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'obsidian_set_toolset',
    description: 'Set visible toolset: core, diagnostics, or full.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        toolset: { type: 'string', enum: ['core', 'diagnostics', 'full'], description: 'Toolset to expose' },
      },
      required: ['toolset'],
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'obsidian_connect',
    description:
      'Connect to Obsidian. Required before other tools. Only a "core" toolset is visible by default — ' +
      'if the task involves probes, screenshots, Excalidraw state, popouts, or main-process JS, call ' +
      'obsidian_discover_tools first rather than approximating it with execute_js.',
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
    description: 'List Obsidian renderer targets.',
    inputSchema: { type: 'object' as const, properties: { port: { type: 'number', default: 9222 } } },
  },
  {
    name: 'obsidian_reload_plugin',
    description: 'Reload a plugin.',
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
    description: 'Read buffered console logs.',
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
          description: 'Maximum entries to return (default 200, maximum 300; use 0 for none)',
        },
        since: {
          type: 'number',
          description: 'Only return logs after this timestamp (ms)',
        },
        clear: {
          type: 'boolean',
          description: 'Clear the log buffer after reading',
        },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'summary returns recent messages without stacks (default); full includes stack traces' },
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
    description: 'Install a disposable renderer event probe.',
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
        captureRaw: { type: 'boolean', description: 'Preserve original JSON payloads for later retrieval; disables event coalescing by default' },
        maxRawEventBytes: { type: 'number', description: 'Maximum bytes per preserved raw payload (default 65536, maximum 1048576)' },
        coalesce: { type: 'boolean', description: 'Coalesce consecutive equivalent summarized events (default true unless captureRaw is enabled)' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['id', 'installer'],
    },
  },
  {
    name: 'obsidian_install_window_probe',
    description: 'Install a probe into every current AND future window matching a pattern (popouts included), so it survives windows opened after this call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Probe identifier (letters, numbers, _, ., :, -). Every matched window gets its own independent buffer under this id.' },
        installer: {
          type: 'string',
          description:
            'JavaScript function expression, e.g. (emit) => { const ref = app.vault.on("modify", f => emit({path:f.path})); return () => app.vault.offref(ref); }',
        },
        urlPattern: { type: 'string', description: 'RegExp source tested against each window\'s webContents URL and title; omit to match every window (main + all popouts)' },
        maxEvents: { type: 'number', description: 'Maximum buffered events per window (default 500, maximum 10000)' },
        captureRaw: { type: 'boolean', description: 'Preserve original JSON payloads for later retrieval; disables event coalescing by default' },
        maxRawEventBytes: { type: 'number', description: 'Maximum bytes per preserved raw payload (default 65536, maximum 1048576)' },
        coalesce: { type: 'boolean', description: 'Coalesce consecutive equivalent summarized events (default true unless captureRaw is enabled)' },
      },
      required: ['id', 'installer'],
    },
  },
  {
    name: 'obsidian_remove_window_probe',
    description: 'Stop future auto-injection for a window probe. Windows it already reached keep running their probe until removed there directly or the session disconnects.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Probe identifier passed to obsidian_install_window_probe' } },
      required: ['id'],
    },
  },
  {
    name: 'obsidian_list_window_probes',
    description: 'List active window-probe hooks (the main-process auto-injection registry, not per-window event buffers -- use obsidian_list_probes per target for those).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'obsidian_read_probe',
    description: 'Read buffered probe events.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Probe identifier' },
        since: { type: 'number', description: 'Only events at or after this Unix timestamp in milliseconds' },
        limit: { type: 'number', description: 'Return only the most recent N events (default 50)' },
        clear: { type: 'boolean', description: 'Clear the probe buffer after reading' },
        includeRaw: { type: 'boolean', description: 'Include opt-in preserved raw payload JSON' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['id'],
    },
  },
  {
    name: 'obsidian_watch_frames',
    description:
      'Sample an expression once per animation frame into a probe buffer. The frame-accurate ' +
      'counterpart to event probes, and the right way to verify rendering DURING a gesture: install ' +
      'this, ask the user to perform the drag/draw themselves, then obsidian_read_probe. Prefer this ' +
      'over dispatching synthetic pointer events, which can appear to work while testing something ' +
      'else. Helpers in scope: $canvas(selector) (bitmap size, opaque-pixel count, sampled hash for ' +
      'every match), $pixel(selector, x, y) (RGBA at CSS coordinates), $render() (visibility/rAF ' +
      'state). Samples nothing while the window is hidden, because rAF is paused then.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Probe identifier (letters, numbers, _, ., :, -)' },
        expression: {
          type: 'string',
          description:
            'Expression evaluated each sampled frame, e.g. $canvas(".epr-front-of-embed-overlay") or ' +
            '({ overlay: $canvas("canvas.overlay")[0]?.hash, zoom: app.workspace.activeLeaf.view.excalidrawAPI.getAppState().zoom.value })',
        },
        sampleEvery: { type: 'number', description: 'Sample every Nth frame (default 1)' },
        maxFrames: { type: 'number', description: 'Stop after this many samples (default 0 = until removed)' },
        maxEvents: { type: 'number', description: 'Maximum buffered samples (default 500, maximum 10000)' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['id', 'expression'],
    },
  },
  {
    name: 'obsidian_canvas_probe',
    description:
      'Measure canvases without hand-writing getImageData: returns bitmap/CSS size, opaque-pixel ' +
      'count, coverage percent and a sampled content hash for EVERY element matching the selector, so ' +
      'two canvases can be compared in one call. Use pumpFrames to force frames first when the window ' +
      'is backgrounded, otherwise the pixels read may be stale.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector; all matches are measured (e.g. ".excalidraw canvas")' },
        at: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional [x, y] in CSS pixels; returns the RGBA value at that point of the first match',
        },
        pumpFrames: { type: 'number', description: 'Force this many frames before reading (default 0; try 2 when hidden)' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['selector'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'obsidian_excalidraw_snapshot',
    description:
      'Capture a restorable copy of an open Excalidraw scene before mutating it. Take one before any ' +
      'destructive experiment on a real vault: elements are stored verbatim, including the fractional ' +
      '`index` values Excalidraw derives z-order from, so a restore is exact. Written to disk, so it ' +
      'survives an MCP or renderer restart.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Excalidraw file path; optional when exactly one view is open' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
    },
  },
  {
    name: 'obsidian_excalidraw_restore',
    description:
      'Restore a scene captured by obsidian_excalidraw_snapshot, then verify it: the result reports ' +
      'whether element ids came back in the captured ORDER, because writing an array back does not by ' +
      'itself determine z-order (Excalidraw sorts by fractional index).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        token: { type: 'string', description: 'Token returned by obsidian_excalidraw_snapshot' },
        restoreViewport: { type: 'boolean', description: 'Also restore scroll/zoom (default false)' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['token'],
    },
  },
  {
    name: 'obsidian_watch_excalidraw',
    description: 'Watch an Excalidraw scene; compact mode is default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Probe identifier' },
        file: { type: 'string', description: 'Excalidraw file path' },
        maxEvents: { type: 'number', description: 'Maximum buffered events (default 500)' },
        noise: { type: 'string', enum: ['compact', 'all'], description: 'Output detail for UI-only callbacks (default compact)' },
        captureRaw: { type: 'boolean', description: 'Preserve original elements, app state, and files as raw JSON; disables coalescing by default' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['id', 'file'],
    },
  },
  {
    name: 'obsidian_start_excalidraw_bug_window',
    description: 'Start a bounded Excalidraw bug capture.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Open Excalidraw file path to record' },
        id: { type: 'string', description: 'Optional capture identifier; generated when omitted' },
        maxEvents: { type: 'number', description: 'Maximum scene events to buffer (default 500)' },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['file'],
    },
  },
  {
    name: 'obsidian_finish_excalidraw_bug_window',
    description: 'Finish an Excalidraw bug capture and return a report.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Capture identifier returned by obsidian_start_excalidraw_bug_window' },
        keepOpen: { type: 'boolean', description: 'Keep the listener installed for another reproduction (default false)' },
        eventLimit: { type: 'number', description: 'Maximum scene events included in the report (default 50)' },
        detail: { type: 'string', enum: ['summary', 'timeline', 'sources'], description: 'Report evidence view: counts only, one merged timeline (default), or separate scene/console arrays' },
      },
      required: ['id'],
    },
  },
  {
    name: 'obsidian_get_diagnostic_timeline',
    description: 'Merge probe, console, and plugin events by time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        probeId: { type: 'string', description: 'Optional probe whose events to include' },
        pluginId: { type: 'string', description: 'Optional plugin whose getDiagnostics().events to include' },
        since: { type: 'number', description: 'Only include entries at or after this Unix timestamp in milliseconds' },
        limit: { type: 'number', description: 'Maximum timeline entries (default 50, maximum 1000)' },
        targetId: { type: 'string', description: 'CDP target ID for probe/plugin lookup' },
      },
    },
  },
  {
    name: 'obsidian_remove_probe',
    description: 'Remove a renderer probe.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Probe identifier' }, targetId: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'obsidian_list_probes',
    description: 'List renderer probes.',
    inputSchema: { type: 'object' as const, properties: { targetId: { type: 'string' } } },
  },
  {
    name: 'obsidian_execute_js',
    description:
      'Run JavaScript in the Obsidian renderer. Each call gets its own async function scope, so ' +
      'declarations never collide between calls and `await` works at top level. Pass either an ' +
      'expression (its value is returned) or statements that `return` a value. Results are flagged ' +
      'when the renderer is not painting — see pumpFrames.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'An expression, or statements that return a value. May use await.',
        },
        pumpFrames: {
          type: 'number',
          description:
            'Force this many frames before evaluating (default 0, maximum 60). Needed for pixel or ' +
            'rAF-dependent reads while Obsidian is backgrounded, since a hidden renderer stops firing ' +
            'requestAnimationFrame and canvas reads then return a stale bitmap. Try 2.',
        },
        targetId: { type: 'string', description: 'CDP target ID; omit for the main Obsidian renderer' },
      },
      required: ['code'],
    },
  },
  {
    name: 'obsidian_execute_js_main',
    description: 'Run a synchronous JavaScript expression in Electron main.',
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
    description: 'Wait for a renderer predicate to be truthy.',
    inputSchema: { type: 'object' as const, properties: {
      predicate: { type: 'string', description: 'JavaScript function expression or expression, e.g. () => !!document.querySelector(".excalidraw")' },
      timeoutMs: { type: 'number', default: 5000 }, intervalMs: { type: 'number', default: 100 }, targetId: { type: 'string' },
    }, required: ['predicate'] },
  },
  {
    name: 'obsidian_get_native_windows',
    description: 'Inspect Electron windows.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'obsidian_get_excalidraw_state',
    description: 'Compare live and persisted Excalidraw state.',
    inputSchema: { type: 'object' as const, properties: { file: { type: 'string' }, targetId: { type: 'string' }, detail: { type: 'string', enum: ['summary', 'full'], description: 'summary returns counts and difference IDs (default); full includes element records' } } },
  },
  {
    name: 'obsidian_get_plugin_info',
    description: 'Inspect installed plugins.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pluginId: {
          type: 'string',
          description: 'Specific plugin ID (omit for all plugins)',
        },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'summary omits the full manifest (default)' },
      },
    },
  },
  {
    name: 'obsidian_list_commands',
    description: 'List Obsidian commands.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filter: {
          type: 'string',
          description: 'Filter commands by name (case-insensitive substring match)',
        },
        limit: { type: 'number', description: 'Maximum commands to return (default 50, maximum 200)' },
      },
    },
  },
  {
    name: 'obsidian_list_leaves',
    description: 'List open workspace leaves and their windows.',
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
    description: 'Run an Obsidian command.',
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
    description: 'Get vault metadata.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'obsidian_get_plugin_settings',
    description: 'Read plugin settings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pluginId: {
          type: 'string',
          description: 'The plugin ID to get settings for',
        },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'summary returns setting keys and a preview (default)' },
      },
      required: ['pluginId'],
    },
  },
  {
    name: 'obsidian_get_plugin_diagnostics',
    description: 'Read plugin diagnostics.',
    inputSchema: { type: 'object' as const, properties: { pluginId: { type: 'string', description: 'Plugin ID' }, since: { type: 'number', description: 'Only return events at or after this timestamp' }, limit: { type: 'number', description: 'Maximum events to return (default 25, maximum 200)' }, detail: { type: 'string', enum: ['summary', 'full'], description: 'summary previews diagnostic values (default)' } }, required: ['pluginId'] },
  },
  {
    name: 'obsidian_get_store_state',
    description: 'Read plugin store state.',
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
        detail: { type: 'string', enum: ['summary', 'full'], description: 'summary previews store values (default)' },
      },
      required: ['pluginId'],
    },
  },
  {
    name: 'obsidian_call_plugin_mcp',
    description: 'Call a plugin’s embedded MCP tool.',
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
        detail: { type: 'string', enum: ['summary', 'full'], description: 'summary previews the plugin MCP result (default)' },
      },
      required: ['pluginId', 'toolName'],
    },
  },
  {
    name: 'obsidian_capture_screenshot',
    description: 'Capture a viewport or element screenshot.',
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

// Tool definitions are part of the model's context on many MCP clients. Keep
// the default focused on the normal edit/reload/debug loop; specialised tools
// remain available after an explicit, discoverable switch.
const CORE_TOOL_NAMES = [
  'obsidian_discover_tools', 'obsidian_set_toolset',
  'obsidian_connect', 'obsidian_disconnect', 'obsidian_reload_plugin',
  'obsidian_get_console_logs', 'obsidian_clear_console_logs',
  'obsidian_execute_js', 'obsidian_wait_for_condition',
  'obsidian_get_plugin_info', 'obsidian_list_commands',
  'obsidian_trigger_command', 'obsidian_get_vault_info',
  'obsidian_get_plugin_settings',
];
const toolRegistry = new ToolRegistry(allTools, CORE_TOOL_NAMES);
let activeToolset: Toolset = toolRegistry.normalize(process.env.OBSIDIAN_MCP_TOOLSET);

function toolCatalog(task?: string) {
  const discovery = toolRegistry.discover(task);
  const recommended = discovery.recommendedToolset;
  // Toolsets are cumulative, so only recommend switching when it would actually
  // reveal something. Saying "set diagnostics" to a session already on full read
  // as advice to give up tools it had.
  const alreadyCovered = toolRegistry.covers(activeToolset, recommended);
  return {
    activeToolset,
    recommendedToolset: recommended,
    matches: discovery.matches,
    toolsets: toolRegistry.catalog(),
    next: alreadyCovered
      ? `The recommended tools are already visible under the active "${activeToolset}" toolset; no switch needed.`
      : `Call obsidian_set_toolset with toolset: ${recommended}; compatible clients will refresh the tool list.`,
  };
}

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolRegistry.list(activeToolset),
}));

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (!toolRegistry.has(activeToolset, name)) {
      throw new Error(`Tool ${name} is not enabled. Call obsidian_discover_tools, then obsidian_set_toolset if needed.`);
    }
    switch (name) {
      case 'obsidian_discover_tools': {
        return { content: [{ type: 'text', text: toolText(toolCatalog(args?.task as string | undefined)) }] };
      }

      case 'obsidian_set_toolset': {
        const toolset = args?.toolset as Toolset | undefined;
        if (toolset !== 'core' && toolset !== 'diagnostics' && toolset !== 'full') {
          throw new Error('toolset must be core, diagnostics, or full');
        }
        activeToolset = toolset;
        // The notification is advisory; older clients may require reconnecting
        // before their cached tool list reflects the newly selected profile.
        try { await server.sendToolListChanged(); } catch (_) {}
        return { content: [{ type: 'text', text: toolText({
          activeToolset,
          visibleToolCount: toolRegistry.list(activeToolset).length,
          next: 'Refresh tools if your client does not update them automatically.',
        }) }] };
      }

      case 'obsidian_connect': {
        const port = (args?.port as number) ?? 9222;
        const info = await obsidian.connect(port);
        // Reported at connect because it silently invalidates pixel-level and
        // rAF-dependent readings for the whole session, and an agent driving
        // Obsidian over CDP is essentially never the focused window.
        const render = await obsidian.getRenderState();
        return {
          content: [
            {
              type: 'text',
              text: toolText(
                {
                  status: 'connected',
                  obsidian: info,
                  render,
                  ...(render.rafPaused
                    ? {
                        renderStateWarning:
                          `Obsidian is ${render.visibility}: the renderer is NOT firing requestAnimationFrame, ` +
                          'so rAF-driven rendering is frozen and canvas pixel reads will be stale (while ' +
                          'screenshots force a frame and look correct). Pass pumpFrames to execute_js / ' +
                          'canvas_probe, or ask the user to focus the window.',
                      }
                    : {}),
                  hint:
                    'Only the "core" toolset is visible right now. Before polling the DOM in a loop or ' +
                    'writing your own probe via execute_js: call obsidian_discover_tools with your task — ' +
                    'probes, per-frame sampling, canvas measurement, scene snapshot/restore, screenshots, ' +
                    'Excalidraw state, popouts, and main-process JS are gated behind ' +
                    'obsidian_set_toolset(diagnostics|full) and are easy to miss otherwise.',
                }
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
        return { content: [{ type: 'text', text: toolText(result) }] };
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
              text: toolText(
                {
                  status: 'reloaded',
                  pluginId,
                  errors: reloadLogs.map((l) => l.message),
                }
              ),
            },
          ],
        };
      }

      case 'obsidian_get_console_logs': {
        const detail = detailOf(args as Record<string, unknown> | undefined);
        const logs = obsidian.getConsoleLogs({
          level: args?.level as 'log' | 'warn' | 'error' | 'info' | 'debug' | 'all',
          limit: (args?.limit as number | undefined) ?? (detail === 'summary' ? 50 : undefined),
          since: args?.since as number,
          clear: args?.clear as boolean,
        });

        return {
          content: [
            {
              type: 'text',
              text: toolText(
                { count: logs.length, logs: logs.map((l) => ({
                  firstSeen: new Date(l.timestamp).toISOString(),
                  lastSeen: new Date(l.lastTimestamp).toISOString(),
                  count: l.repeatCount,
                  targetId: l.targetId,
                  level: l.level,
                  message: l.message,
                  ...(detail === 'full' ? { stackTrace: l.stackTrace } : {}),
                })) },
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
        const result = await obsidian.installProbe(id, installer, args?.maxEvents as number | undefined, args?.targetId as string | undefined, {
          captureRaw: args?.captureRaw as boolean | undefined,
          maxRawEventBytes: args?.maxRawEventBytes as number | undefined,
          coalesce: args?.coalesce as boolean | undefined,
        });
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_install_window_probe': {
        const id = args?.id as string;
        const installer = args?.installer as string;
        if (!id) throw new Error('id is required');
        if (!installer) throw new Error('installer is required');
        const result = await obsidian.installWindowProbe(
          id,
          installer,
          args?.urlPattern as string | undefined,
          args?.maxEvents as number | undefined,
          {
            captureRaw: args?.captureRaw as boolean | undefined,
            maxRawEventBytes: args?.maxRawEventBytes as number | undefined,
            coalesce: args?.coalesce as boolean | undefined,
          },
        );
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_remove_window_probe': {
        const id = args?.id as string;
        if (!id) throw new Error('id is required');
        const result = await obsidian.removeWindowProbe(id);
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_list_window_probes': {
        const result = await obsidian.listWindowProbes();
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_read_probe': {
        const id = args?.id as string;
        if (!id) throw new Error('id is required');
        const result = await obsidian.readProbe(id, {
          since: args?.since as number | undefined,
          limit: (args?.limit as number | undefined) ?? 50,
          clear: args?.clear as boolean | undefined,
          includeRaw: args?.includeRaw as boolean | undefined,
        }, args?.targetId as string | undefined);
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_watch_excalidraw': {
        const id = args?.id as string;
        const file = args?.file as string;
        if (!id || !file) throw new Error('id and file are required');
        const noise = (args?.noise as 'compact' | 'all' | undefined) ?? 'compact';
        const installer = excalidrawWatcherInstaller(file, noise);
        const result = await obsidian.installProbe(id, installer, args?.maxEvents as number | undefined, args?.targetId as string | undefined, {
          captureRaw: args?.captureRaw as boolean | undefined,
        });
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_start_excalidraw_bug_window': {
        const file = args?.file as string;
        const targetId = obsidian.resolveTargetId(args?.targetId as string | undefined);
        if (!file) throw new Error('file is required');
        const id = (args?.id as string | undefined) ?? `bug-window:${Date.now()}`;
        if (bugWindows.has(id)) throw new Error(`Bug window already exists: ${id}`);
        const startedAt = Date.now();
        const baseline = await getExcalidrawSceneSummary(file, targetId);
        const consoleCounts = new Map(obsidian.getConsoleLogs({ level: 'all', limit: 300 })
          .map(log => [consoleKey(log), log.repeatCount]));
        await obsidian.installProbe(id, excalidrawWatcherInstaller(file), args?.maxEvents as number | undefined, targetId, {
          captureRaw: false,
          coalesce: true,
        });
        bugWindows.set(id, { id, file, startedAt, targetId, baseline, consoleCounts });
        return { content: [{ type: 'text', text: toolText({
          id, status: 'recording', file, startedAt, baseline,
          next: 'Reproduce the problem, then call obsidian_finish_excalidraw_bug_window with this id.',
        }) }] };
      }

      case 'obsidian_finish_excalidraw_bug_window': {
        const id = args?.id as string;
        if (!id) throw new Error('id is required');
        const capture = bugWindows.get(id);
        if (!capture) throw new Error(`No active bug window named: ${id}`);
        const endedAt = Date.now();
        const eventLimit = Math.max(1, Math.min(1000, Math.floor((args?.eventLimit as number | undefined) ?? 50)));
        const detail = (args?.detail as 'summary' | 'timeline' | 'sources' | undefined) ?? 'timeline';
        const probe = await obsidian.readProbe(id, { since: capture.startedAt, limit: eventLimit }, capture.targetId) as {
          events?: Array<{ timestamp: number; lastTimestamp?: number; count?: number; data: unknown }>;
        };
        const sceneEvents = probe.events ?? [];
        const allLogs = obsidian.getConsoleLogs({
          since: capture.startedAt,
          level: 'all',
          limit: 300,
          targetId: capture.targetId,
        });
        const consoleEvents = allLogs.map(log => {
          const baselineCount = capture.consoleCounts.get(consoleKey(log)) ?? 0;
          return {
            firstSeen: new Date(log.timestamp).toISOString(), lastSeen: new Date(log.lastTimestamp).toISOString(),
            count: Math.max(0, log.repeatCount - baselineCount), targetId: log.targetId,
            level: log.level, message: log.message, stackTrace: log.stackTrace,
          };
        }).filter(log => log.count > 0 || Date.parse(log.lastSeen) >= capture.startedAt);
        const final = await getExcalidrawSceneSummary(capture.file, capture.targetId);
        const timeline = [
          ...sceneEvents.map(event => ({ source: 'scene', timestamp: event.timestamp, lastTimestamp: event.lastTimestamp, count: event.count, event: event.data })),
          ...consoleEvents.map(event => ({ source: 'console', timestamp: Math.max(Date.parse(event.firstSeen), capture.startedAt), lastTimestamp: Date.parse(event.lastSeen), count: event.count, level: event.level, message: event.message, stackTrace: event.stackTrace })),
        ].sort((a, b) => a.timestamp - b.timestamp).slice(-eventLimit);
        const keepOpen = args?.keepOpen === true;
        if (!keepOpen) {
          await obsidian.removeProbe(id, capture.targetId);
          bugWindows.delete(id);
        }
        const report = {
          id, status: keepOpen ? 'recording' : 'finished', file: capture.file,
          window: { startedAt: capture.startedAt, endedAt, durationMs: endedAt - capture.startedAt },
          baseline: capture.baseline, final,
          evidence: {
            view: detail,
            sceneEventCount: sceneEvents.length,
            sceneCallbackCount: sceneEvents.reduce((total, event) => total + (event.count ?? 1), 0),
            consoleEventCount: consoleEvents.length,
            consoleOccurrenceCount: consoleEvents.reduce((total, event) => total + event.count, 0),
          },
        };
        const evidence = detail === 'timeline'
          ? { timeline }
          : detail === 'sources'
            ? { sceneEvents, consoleEvents }
            : {};
        return { content: [{ type: 'text', text: toolText({ ...report, ...evidence }) }] };
      }

      case 'obsidian_get_diagnostic_timeline': {
        const since = args?.since as number | undefined;
        const limit = Math.max(1, Math.min(1000, Math.floor((args?.limit as number | undefined) ?? 50)));
        const targetId = args?.targetId as string | undefined;
        const probeId = args?.probeId as string | undefined;
        const pluginId = args?.pluginId as string | undefined;
        const probe = probeId ? await obsidian.readProbe(probeId, { since, limit }, targetId) as { events?: Array<{ timestamp: number; lastTimestamp?: number; count?: number; data: unknown }> } : undefined;
        const pluginEvents = pluginId ? await obsidian.evaluateInTarget<Array<{ timestamp?: number; [key: string]: unknown }>>(`(() => {
          const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
          const value = plugin?.getDiagnostics?.();
          return Array.isArray(value?.events) ? value.events : [];
        })()`, targetId) : [];
        const timeline = [
          ...(probe?.events || []).map(event => ({ source: 'probe', timestamp: event.timestamp, lastTimestamp: event.lastTimestamp, count: event.count, event: event.data })),
          ...obsidian.getConsoleLogs({ since, limit: 300, targetId }).map(log => ({ source: 'console', timestamp: log.timestamp, lastTimestamp: log.lastTimestamp, count: log.repeatCount, targetId: log.targetId, level: log.level, message: log.message, stackTrace: log.stackTrace })),
          ...pluginEvents.filter(event => typeof event.timestamp === 'number' && (since == null || event.timestamp >= since)).map(event => ({ source: 'plugin', timestamp: event.timestamp as number, event })),
        ].sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
        return { content: [{ type: 'text', text: toolText({ timeline, sources: { probeId, pluginId } }) }] };
      }

      case 'obsidian_remove_probe': {
        const id = args?.id as string;
        if (!id) throw new Error('id is required');
        const result = await obsidian.removeProbe(id, args?.targetId as string | undefined);
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_list_probes': {
        const result = await obsidian.listProbes(args?.targetId as string | undefined);
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_execute_js': {
        const code = args?.code as string;
        if (!code) {
          throw new Error('code is required');
        }

        const { value, render } = await obsidian.evaluateUserCode(code, {
          targetId: args?.targetId as string | undefined,
          pumpFrames: args?.pumpFrames as number | undefined,
        });
        const warning = renderWarning(render);
        return {
          content: [
            { type: 'text', text: toolText(value) },
            // A separate block rather than wrapping the value, so the result shape
            // callers already parse is unchanged and the warning is still unmissable.
            ...(warning ? [{ type: 'text', text: toolText({ renderStateWarning: warning, render }) }] : []),
          ],
        };
      }

      case 'obsidian_watch_frames': {
        const id = args?.id as string;
        const expression = args?.expression as string;
        if (!id || !expression) throw new Error('id and expression are required');
        const targetId = args?.targetId as string | undefined;
        const installer = frameWatcherInstaller(
          expression,
          (args?.sampleEvery as number | undefined) ?? 1,
          (args?.maxFrames as number | undefined) ?? 0,
        );
        const result = await obsidian.installProbe(
          id,
          installer,
          args?.maxEvents as number | undefined,
          targetId,
          { coalesce: true },
        );
        const render = await obsidian.getRenderState(targetId);
        return {
          content: [{ type: 'text', text: toolText({
            ...(result as object),
            render,
            next: render.rafPaused
              ? 'Obsidian is hidden, so no frames will be sampled until it is focused. Ask the user to ' +
                'focus the window and perform the interaction, then call obsidian_read_probe.'
              : 'Ask the user to perform the interaction, then call obsidian_read_probe with this id.',
          }) }],
        };
      }

      case 'obsidian_canvas_probe': {
        const selector = args?.selector as string;
        if (!selector) throw new Error('selector is required');
        const targetId = args?.targetId as string | undefined;
        const at = args?.at as [number, number] | undefined;
        const pumped = await obsidian.pumpFrames((args?.pumpFrames as number | undefined) ?? 0, targetId);
        const result = await obsidian.evaluateInTarget(`(() => {
          ${CANVAS_HELPERS_JS}
          return {
            render: $render(),
            canvases: $canvas(${JSON.stringify(selector)}),
            ${at ? `pixel: $pixel(${JSON.stringify(selector)}, ${Number(at[0])}, ${Number(at[1])}),` : ''}
          };
        })()`, targetId);
        const render = (result as { render?: RenderState }).render;
        const warning = pumped ? null : renderWarning(render);
        return {
          content: [
            { type: 'text', text: toolText({ ...(result as object), framesPumped: pumped }) },
            ...(warning ? [{ type: 'text', text: toolText({ renderStateWarning: warning }) }] : []),
          ],
        };
      }

      case 'obsidian_excalidraw_snapshot': {
        const snapshot = await captureSceneSnapshot(
          args?.file as string | undefined,
          args?.targetId as string | undefined,
        );
        return {
          content: [{ type: 'text', text: toolText({
            ...snapshot,
            next: `Mutate freely, then obsidian_excalidraw_restore with token "${snapshot.token}".`,
          }) }],
        };
      }

      case 'obsidian_excalidraw_restore': {
        const token = args?.token as string;
        if (!token) throw new Error('token is required');
        const result = await restoreSceneSnapshot(token, {
          targetId: args?.targetId as string | undefined,
          restoreViewport: args?.restoreViewport as boolean | undefined,
        });
        return { content: [{ type: 'text', text: toolText(result) }] };
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
                toolText(result),
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
        return { content: [{ type: 'text', text: toolText(result) }] };
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
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_get_excalidraw_state': {
        const file = args?.file as string | undefined;
        const detail = detailOf(args as Record<string, unknown> | undefined);
        const result = await obsidian.evaluateInTarget(`(() => {
          const wanted = ${JSON.stringify(file ?? null)};
          const includeElements = ${detail === 'full'};
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
              persistedElementCount: persisted.length,
              ...(includeElements
                ? { liveFileIds: Object.keys(liveFiles), persistedFileIds: Object.keys(persistedFiles), differences }
                : { liveFileCount: Object.keys(liveFiles).length, persistedFileCount: Object.keys(persistedFiles).length,
                    differenceCount: differences.length, differenceIds: differences.slice(0, 50), differencesTruncated: differences.length > 50 }),
              ...(includeElements ? { elements: { live: live.map(safeElement), persisted: persisted.map(safeElement) } } : {}) });
          });
          return rows;
        })()`, args?.targetId as string | undefined);
        return { content: [{ type: 'text', text: toolText(result) }] };
      }

      case 'obsidian_get_plugin_info': {
        const pluginId = args?.pluginId as string | undefined;
        const detail = detailOf(args as Record<string, unknown> | undefined);

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
                ...( ${detail === 'full'} ? { manifest } : { name: manifest.name, version: manifest.version, author: manifest.author ?? null }),
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
          content: [{ type: 'text', text: toolText(result) }],
        };
      }

      case 'obsidian_list_commands': {
        const filter = args?.filter as string | undefined;
        const limit = Math.max(1, Math.min(200, Math.floor((args?.limit as number | undefined) ?? 50)));

        const result = await obsidian.evaluate(`
          (function() {
            const commands = app.commands.commands;
            const filter = ${filter ? JSON.stringify(filter.toLowerCase()) : 'null'};

            const matches = Object.values(commands)
              .filter(cmd => !filter || cmd.name.toLowerCase().includes(filter))
              .map(cmd => ({
                id: cmd.id,
                name: cmd.name
              }))
              .sort((a, b) => a.name.localeCompare(b.name));
            return { count: matches.length, commands: matches.slice(0, ${limit}), truncated: matches.length > ${limit} };
          })()
        `);

        return {
          content: [{ type: 'text', text: toolText(result) }],
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
          content: [{ type: 'text', text: toolText(result) }],
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
          content: [{ type: 'text', text: toolText(result) }],
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
          content: [{ type: 'text', text: toolText(result) }],
        };
      }

      case 'obsidian_get_plugin_settings': {
        const pluginId = args?.pluginId as string;
        const detail = detailOf(args as Record<string, unknown> | undefined);
        if (!pluginId) {
          throw new Error('pluginId is required');
        }

        const result = await obsidian.evaluate(`
          (function() {
            const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
            if (!plugin) {
              return { error: 'Plugin not loaded: ' + ${JSON.stringify(pluginId)} };
            }
            const settings = plugin.settings || {};
            if (${detail === 'full'}) return settings;
            const keys = Object.keys(settings);
            return { pluginId: ${JSON.stringify(pluginId)}, settingCount: keys.length, keys: keys.slice(0, 50), preview: Object.fromEntries(keys.slice(0, 10).map(key => [key, typeof settings[key]])) };
          })()
        `);

        return {
          content: [{ type: 'text', text: toolText(result) }],
        };
      }

      case 'obsidian_get_plugin_diagnostics': {
        const pluginId = args?.pluginId as string;
        if (!pluginId) throw new Error('pluginId is required');
        const detail = detailOf(args as Record<string, unknown> | undefined);
        const since = args?.since as number | undefined;
        const requestedLimit = args?.limit as number | undefined;
        const limit = requestedLimit == null || !Number.isFinite(requestedLimit)
          ? 25
          : Math.max(0, Math.min(200, Math.floor(requestedLimit)));
        const eventSlice = limit === 0 ? 'events.slice(0, 0)' : `events.slice(-${limit})`;
        const result = await obsidian.evaluate(`(() => {
          const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
          if (!plugin) return { error: 'Plugin not loaded: ' + ${JSON.stringify(pluginId)} };
          if (typeof plugin.getDiagnostics !== 'function') return {
            supported: false,
            availableKeys: Object.keys(plugin).filter(k => !k.startsWith('_')),
          };
          const value = plugin.getDiagnostics();
          if (Array.isArray(value?.events)) {
            const events = ${since == null ? 'value.events' : `value.events.filter(e => e.timestamp >= ${Math.floor(since)})`};
            return { supported: true, value: { ...value, events: ${eventSlice} } };
          }
          return { supported: true, value };
        })()`);
        return { content: [{ type: 'text', text: toolText(detail === 'full' ? result : summarizeValue(result)) }] };
      }

      case 'obsidian_get_store_state': {
        const pluginId = args?.pluginId as string;
        const storeName = args?.storeName as string | undefined;
        const detail = detailOf(args as Record<string, unknown> | undefined);

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
          content: [{ type: 'text', text: toolText(detail === 'full' ? result : summarizeValue(result)) }],
        };
      }

      case 'obsidian_call_plugin_mcp': {
        const pluginId = args?.pluginId as string;
        const toolName = args?.toolName as string;
        const toolArgs = (args?.arguments as Record<string, unknown>) || {};
        const detail = detailOf(args as Record<string, unknown> | undefined);

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
          content: [{ type: 'text', text: toolText(detail === 'full' ? result : summarizeValue(result)) }],
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
                text: toolText(
                  { saved: outputPath, size: buffer.length, format }
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: toolText(
                {
                  format,
                  dataLength: base64Data.length,
                  data:
                    base64Data.substring(0, 100) +
                    '... (truncated, use outputPath to save full image)',
                }
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
      content: [{ type: 'text', text: toolText(`Error: ${message}`) }],
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
