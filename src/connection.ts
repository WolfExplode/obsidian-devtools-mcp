import CDP from 'chrome-remote-interface';

interface StackTrace {
  description?: string;
  callFrames: Array<{
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  }>;
}

export interface ConsoleEntry {
  timestamp: number;
  lastTimestamp: number;
  repeatCount: number;
  targetId?: string;
  level: string;
  message: string;
  args: unknown[];
  stackTrace?: StackTrace;
}

export interface ObsidianInfo {
  version: string;
  vaultName: string;
  vaultPath: string;
}

export interface ProbeEvent {
  sequence?: number;
  timestamp: number;
  lastTimestamp?: number;
  count?: number;
  data: unknown;
  rawData?: string;
}

export class ObsidianConnection {
  private client: CDP.Client | null = null;
  private mainTargetId: string | null = null;
  private connectedPort = 9222;
  private targetClients = new Map<string, CDP.Client>();
  private consoleLogs: ConsoleEntry[] = [];
  private connected = false;
  // Console output is diagnostic context, not an archival log. Keeping this
  // small prevents a noisy vault from silently inflating every later request.
  private readonly MAX_LOG_ENTRIES = 300;
  private readonly MAX_LOG_MESSAGE_CHARS = 4000;
  private readonly MAX_STACK_FRAMES = 8;
  private readonly MAX_STACK_FRAME_TEXT_CHARS = 1024;

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  resolveTargetId(targetId?: string): string {
    const resolved = targetId ?? this.mainTargetId;
    if (!resolved) throw new Error('Not connected to Obsidian. Use obsidian_connect first.');
    return resolved;
  }

  async connect(port: number = 9222): Promise<ObsidianInfo> {
    if (this.client) {
      await this.disconnect();
    }

    // List available targets
    const targets = await CDP.List({ port });

    // Find the main Obsidian window (not devtools, not extensions)
    const mainTarget = targets.find(
      (t) =>
        t.type === 'page' &&
        !t.url.startsWith('devtools://') &&
        !t.url.startsWith('chrome-extension://') &&
        (t.title.includes('Obsidian') || t.url.startsWith('app://'))
    );

    if (!mainTarget) {
      throw new Error(
        'Could not find Obsidian main window. Available targets: ' +
          targets.map((t) => `${t.type}: ${t.title || t.url}`).join(', ')
      );
    }

    const client = await CDP({ port, target: mainTarget.id });
    this.client = client;
    this.mainTargetId = mainTarget.id;
    this.connectedPort = port;

    // Enable necessary domains
    await client.Runtime.enable();
    await client.Page.enable();

    // Set up console log capture
    this.registerConsoleCapture(client, mainTarget.id);

    // Handle disconnection
    client.on('disconnect', () => {
      // Do not let a late disconnect from an older connection tear down a
      // newer session created by reconnecting.
      if (this.client !== client) return;
      this.connected = false;
      this.client = null;
      this.mainTargetId = null;
      // Attached popout targets belong to the same CDP session. Their clients
      // are no longer usable after the main target disconnects, so discard them
      // rather than reusing dead sockets on a later obsidian_connect.
      const targetClients = [...this.targetClients.values()];
      this.targetClients.clear();
      for (const targetClient of targetClients) {
        void targetClient.close().catch(() => {});
      }
    });

    this.connected = true;

    // Get Obsidian info
    const info = await this.evaluate<ObsidianInfo>(`
      (function() {
        return {
          version: app.version || 'unknown',
          vaultName: app.vault.getName(),
          vaultPath: app.vault.adapter.basePath
        };
      })()
    `);

    return info;
  }

  private registerConsoleCapture(client: CDP.Client, targetId: string): void {
    client.Runtime.consoleAPICalled((params) => {
      const args = params.args.map((arg) => {
        if (arg.type === 'string') return arg.value;
        if (arg.type === 'number') return arg.value;
        if (arg.type === 'boolean') return arg.value;
        if (arg.type === 'undefined') return undefined;
        if (arg.type === 'object' && arg.preview) {
          return arg.preview.description || JSON.stringify(arg.preview.properties);
        }
        return arg.description || `[${arg.type}]`;
      });

      const message = args.join(' ');
      const stackTrace = params.stackTrace
        ? {
            callFrames: params.stackTrace.callFrames
              .slice(0, this.MAX_STACK_FRAMES)
              .map((frame) => ({
                functionName: frame.functionName.slice(0, this.MAX_STACK_FRAME_TEXT_CHARS),
                scriptId: frame.scriptId,
                url: frame.url.slice(0, this.MAX_STACK_FRAME_TEXT_CHARS),
                lineNumber: frame.lineNumber,
                columnNumber: frame.columnNumber,
              })),
          }
        : undefined;
      const timestamp = Date.now();
      const entry: ConsoleEntry = {
        timestamp,
        lastTimestamp: timestamp,
        repeatCount: 1,
        targetId,
        level: params.type,
        message: message.length > this.MAX_LOG_MESSAGE_CHARS
          ? message.slice(0, this.MAX_LOG_MESSAGE_CHARS) + '…'
          : message,
        // Do not retain the full CDP RemoteObject graph. The rendered message
        // plus a compact stack trace preserves useful diagnostic context.
        args: [],
        stackTrace,
      };
      // Group by message and stack signature even when other logs interleave.
      // This makes render-loop failures readable without losing frequency/timing.
      const matching = this.consoleLogs.find((existing) =>
        existing.targetId === entry.targetId &&
        existing.level === entry.level &&
        existing.message === entry.message &&
        JSON.stringify(existing.stackTrace) === JSON.stringify(entry.stackTrace)
      );
      if (matching) {
        matching.repeatCount += 1;
        matching.lastTimestamp = timestamp;
      } else {
        this.consoleLogs.push(entry);
      }

      // Keep buffer bounded
      if (this.consoleLogs.length > this.MAX_LOG_ENTRIES) {
        this.consoleLogs.shift();
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      // Probes are runtime instrumentation, not durable application state.
      // Dispose them when the MCP session ends so a later session cannot inherit
      // stale listeners from an earlier investigation. Each popout is a
      // separate renderer realm, so clean the main renderer and every attached
      // target rather than only the main window.
      const disposeProbes = `
          (() => {
            const root = window.__obsidianDevtoolsProbes;
            if (!root) return 0;
            let removed = 0;
            for (const id of Object.keys(root)) {
              try { root[id].dispose(); } catch (_) {}
              delete root[id];
              removed++;
            }
            return removed;
          })()
        `;
      const targets = [this.client, ...this.targetClients.values()];
      for (const target of targets) {
        try {
          await target.Runtime.evaluate({
            expression: disposeProbes,
            returnByValue: true,
            awaitPromise: true,
          });
        } catch (_) {
          // A popout may already have closed; continue cleaning the remaining
          // renderers and close all CDP connections below.
        }
      }
      // Window-probe hooks live in Obsidian's main process (a
      // browser-window-created listener), which keeps running across MCP
      // server restarts unlike the renderer probes above. Leaving one
      // registered would silently keep auto-injecting into every new window
      // opened by a completely unrelated future session.
      try {
        await this.evaluateMain(`(() => {
          const { app } = require('electron');
          const registry = global.__obsidianDevtoolsWindowHooks || {};
          for (const id of Object.keys(registry)) {
            try { app.removeListener('browser-window-created', registry[id].handler); } catch (e) {}
            delete registry[id];
          }
          return null;
        })()`);
      } catch (_) {
        // Best-effort: main process may already be gone (Obsidian closing).
      }
      for (const target of this.targetClients.values()) {
        try { await target.close(); } catch (_) {}
      }
      this.targetClients.clear();
      await this.client.close();
      this.client = null;
      this.mainTargetId = null;
      this.connected = false;
    }
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (!this.client) {
      throw new Error('Not connected to Obsidian. Use obsidian_connect first.');
    }

    const result = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      const error = result.exceptionDetails;
      throw new Error(
        error.exception?.description || error.text || 'Unknown evaluation error'
      );
    }

    return result.result.value as T;
  }

  async listTargets(port = 9222): Promise<unknown[]> {
    return (await CDP.List({ port })).map((target) => ({
      id: target.id,
      type: target.type,
      title: target.title,
      url: target.url,
      attached: target.id === this.mainTargetId || this.targetClients.has(target.id),
      isMain: target.id === this.mainTargetId,
    }));
  }

  private async getClient(targetId?: string): Promise<CDP.Client> {
    if (!targetId) {
      if (!this.client) throw new Error('Not connected to Obsidian. Use obsidian_connect first.');
      return this.client;
    }
    if (targetId === this.mainTargetId && this.client) return this.client;
    let target = this.targetClients.get(targetId);
    if (!target) {
      target = await CDP({ port: this.connectedPort, target: targetId });
      await target.Runtime.enable();
      await target.Page.enable();
      this.registerConsoleCapture(target, targetId);
      this.targetClients.set(targetId, target);
    }
    return target;
  }

  async evaluateInTarget<T>(expression: string, targetId?: string): Promise<T> {
    const client = await this.getClient(targetId);
    const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const error = result.exceptionDetails;
      throw new Error(error.exception?.description || error.text || 'Unknown evaluation error');
    }
    return result.result.value as T;
  }

  /**
   * Execute code in Electron's MAIN process and return its (JSON-serialized)
   * result. The CDP target is the renderer, so we hop into main via
   * `@electron/remote`'s `vm.runInThisContext` — the code string is compiled and
   * run in the main process's global context. This is the ONLY reliable way from
   * here to *mutate* main-process state (e.g. `delete require.cache[...]`,
   * BrowserWindow tweaks): reaching those objects through the remote proxy and
   * assigning/deleting is a silent no-op, because the proxy forwards function
   * calls but not property writes/deletes.
   *
   * `code` is evaluated as an expression (wrap statements in an IIFE, like
   * obsidian_execute_js). A `require` bound to the main module is in scope.
   * Execution is synchronous — a returned Promise is not awaited. Non-serializable
   * results (functions, etc.) come back stringified rather than throwing.
   */
  async evaluateMain<T>(code: string): Promise<T> {
    if (!this.client) {
      throw new Error('Not connected to Obsidian. Use obsidian_connect first.');
    }
    // The wrapper below interpolates code as `(${code})`, so a trailing
    // semicolon (a near-universal habit, especially after an IIFE) turns a
    // valid expression into `(expr;)` -- a syntax error. Stripping one
    // trailing `;` is always safe: expressions never legitimately end in one.
    code = code.trim().replace(/;+\s*$/, '');
    // Runs in MAIN. process.mainModule.require gives main's require (with .cache).
    const mainWrapper = `
      (function () {
        // In the main process's vm context there is no free \`require\`. Build a
        // full one (with .cache === Module._cache and .resolve) from the main
        // module, so user code can bust the cache, resolve paths, etc. Note that
        // process.mainModule.require is Module.prototype.require and lacks .cache
        // — createRequire is what yields the real thing.
        var require;
        try {
          var Module = process.mainModule.constructor;
          require = Module.createRequire(process.mainModule.filename);
        } catch (e) {
          require = (process.mainModule && process.mainModule.require) ||
            (typeof global !== 'undefined' && global.require);
        }
        var __v;
        try { __v = (${code}); }
        catch (e) { return JSON.stringify({ __error: String((e && e.stack) || e) }); }
        if (typeof __v === 'function') __v = String(__v);
        try { return JSON.stringify(__v === undefined ? null : __v); }
        catch (e) { return JSON.stringify(String(__v)); }
      })()
    `;
    // Runs in the RENDERER: bridge into main and hand it the wrapper string.
    const expression = `
      (function () {
        var req = (typeof require === 'function') ? require : window.require;
        if (!req) throw new Error('nodeIntegration require unavailable in renderer');
        var remote = req('@electron/remote');
        if (!remote || !remote.require) throw new Error('@electron/remote unavailable');
        return remote.require('vm').runInThisContext(${JSON.stringify(mainWrapper)});
      })()
    `;
    const json = await this.evaluate<string>(expression);
    const parsed = json == null ? null : JSON.parse(json);
    if (parsed && typeof parsed === 'object' && '__error' in parsed) {
      throw new Error('Main-process error: ' + (parsed as { __error: string }).__error);
    }
    return parsed as T;
  }

  getConsoleLogs(options?: {
    level?: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'all';
    limit?: number;
    since?: number;
    targetId?: string;
    clear?: boolean;
  }): ConsoleEntry[] {
    let logs = [...this.consoleLogs];

    // Filter by timestamp
    if (options?.since) {
      // Grouped entries can begin before a capture window and continue inside
      // it. Their final occurrence, rather than only their first, determines
      // whether they are relevant to a time-bounded diagnostic report.
      logs = logs.filter((log) => log.lastTimestamp >= options.since!);
    }

    // Filter by level
    if (options?.level && options.level !== 'all') {
      logs = logs.filter((log) => log.level === options.level);
    }

    if (options?.targetId) {
      logs = logs.filter((log) => log.targetId === options.targetId);
    }

    // Limit results
    const requestedLimit = options?.limit;
    const limit = requestedLimit == null || !Number.isFinite(requestedLimit)
      ? 200
      : Math.max(0, Math.min(this.MAX_LOG_ENTRIES, Math.floor(requestedLimit)));
    if (limit === 0) {
      logs = [];
    } else {
      logs = logs.slice(-limit);
    }

    // Clear logs if requested
    if (options?.clear) {
      this.consoleLogs = [];
    }

    return logs;
  }

  clearConsoleLogs(): void {
    this.consoleLogs = [];
  }

  /**
   * Renderer-side script that defines window.__obsidianDevtoolsProbes[id] and
   * runs `installer` against it. Shared by installProbe (single target, called
   * directly) and installWindowProbe (same script, but handed to
   * `webContents.executeJavaScript` from main for every matching window,
   * present and future) so both paths produce probes with identical read/
   * remove/list semantics — obsidian_read_probe works the same either way,
   * just against a different target per window.
   */
  private buildProbeInstallScript(
    id: string,
    installer: string,
    maxEvents: number,
    options?: { captureRaw?: boolean; maxRawEventBytes?: number; coalesce?: boolean },
  ): string {
    if (!/^[A-Za-z0-9_.:-]+$/.test(id)) throw new Error('Probe id contains invalid characters');
    if (!installer.trim()) throw new Error('installer is required');
    const boundedMax = Number.isFinite(maxEvents)
      ? Math.max(1, Math.min(10000, Math.floor(maxEvents)))
      : 500;
    const captureRaw = options?.captureRaw === true;
    const maxRawEventBytes = Number.isFinite(options?.maxRawEventBytes)
      ? Math.max(1024, Math.min(1024 * 1024, Math.floor(options!.maxRawEventBytes!)))
      : 64 * 1024;
    const coalesce = options?.coalesce ?? !captureRaw;
    return `
      (() => {
        const id = ${JSON.stringify(id)};
        const maxEvents = ${boundedMax};
        const captureRaw = ${captureRaw};
        const maxRawEventBytes = ${maxRawEventBytes};
        const coalesce = ${coalesce};
        const root = window.__obsidianDevtoolsProbes ||= Object.create(null);
        if (root[id]) { try { root[id].dispose(); } catch (_) {} }
        const events = [];
        // Probes are commonly attached to high-volume UI callbacks. Normalize their
        // payloads before buffering so one large selection, scene, or error cannot
        // make the entire MCP response unreadable.
        const MAX_EVENT_BYTES = 16 * 1024;
        const MAX_DEPTH = 6;
        const MAX_ARRAY_ITEMS = 50;
        const MAX_OBJECT_KEYS = 50;
        const MAX_STRING_LENGTH = 2048;
        const summarize = (value, depth = 0, seen = new WeakSet()) => {
          if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
          if (typeof value === 'string') {
            return value.length <= MAX_STRING_LENGTH
              ? value
              : { truncated: true, originalLength: value.length, sample: value.slice(0, MAX_STRING_LENGTH) };
          }
          if (typeof value === 'bigint') return String(value) + 'n';
          if (typeof value === 'undefined') return null;
          if (typeof value === 'function' || typeof value === 'symbol') return String(value);
          if (depth >= MAX_DEPTH) return { truncated: true, reason: 'max-depth', type: Array.isArray(value) ? 'array' : typeof value };
          if (typeof value !== 'object') return String(value);
          if (seen.has(value)) return { truncated: true, reason: 'circular' };
          seen.add(value);
          if (Array.isArray(value)) {
            const sample = value.slice(0, MAX_ARRAY_ITEMS).map(item => summarize(item, depth + 1, seen));
            const result = value.length > MAX_ARRAY_ITEMS
              ? { count: value.length, sample, truncated: true }
              : sample;
            seen.delete(value);
            return result;
          }
          const keys = Object.keys(value);
          const output = {};
          for (const key of keys.slice(0, MAX_OBJECT_KEYS)) output[key] = summarize(value[key], depth + 1, seen);
          if (keys.length > MAX_OBJECT_KEYS) {
            output._truncated = true;
            output._omittedKeys = keys.length - MAX_OBJECT_KEYS;
          }
          seen.delete(value);
          return output;
        };
        const safe = (value) => {
          let normalized;
          try { normalized = summarize(value); }
          catch (_) { normalized = { truncated: true, reason: 'normalization-failed', type: typeof value }; }
          let serialized;
          try { serialized = JSON.stringify(normalized); }
          catch (_) { return { truncated: true, reason: 'serialization-failed', type: typeof value }; }
          if (serialized.length <= MAX_EVENT_BYTES) return normalized;
          return {
            truncated: true,
            reason: 'max-event-bytes',
            originalBytes: serialized.length,
            type: Array.isArray(value) ? 'array' : typeof value,
            keys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 20) : undefined,
            count: Array.isArray(value) ? value.length : undefined,
          };
        };
        let sequence = 0;
        // maxRawEventBytes is a storage limit, so enforce it on the final JSON
        // string we retain, not only on the original payload. The old approach
        // serialized a truncation envelope around a max-sized sample, which
        // could expand past the advertised cap through JSON escaping.
        const utf8Bytes = (text) => new TextEncoder().encode(text).length;
        const boundRawJson = (raw) => {
          const originalBytes = utf8Bytes(raw);
          if (originalBytes <= maxRawEventBytes) return raw;
          const envelope = (sample) => JSON.stringify({
            truncated: true,
            reason: 'max-raw-event-bytes',
            originalBytes,
            sample,
          });
          // Find the longest UTF-16 prefix whose *serialized envelope* fits
          // within the UTF-8 byte budget. This also handles samples containing
          // quotes, backslashes, emoji, and other multi-byte characters.
          let low = 0;
          let high = raw.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (utf8Bytes(envelope(raw.slice(0, middle))) <= maxRawEventBytes) low = middle;
            else high = middle - 1;
          }
          return envelope(raw.slice(0, low));
        };
        const emit = (data, originalData = data) => {
          const timestamp = Date.now();
          const normalized = safe(data);
          const signature = JSON.stringify(normalized);
          let rawData;
          if (captureRaw) {
            try {
              rawData = boundRawJson(JSON.stringify(originalData));
            } catch (_) {
              rawData = boundRawJson(JSON.stringify({ truncated: true, reason: 'raw-serialization-failed', type: typeof originalData }));
            }
          }
          const previous = events.at(-1);
          if (coalesce && previous?.signature === signature) {
            previous.count += 1;
            previous.lastTimestamp = timestamp;
            return;
          }
          events.push({ sequence: ++sequence, timestamp, lastTimestamp: timestamp, count: 1, data: normalized, rawData, signature });
          if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
        };
        const factory = (${installer});
        if (typeof factory !== 'function') throw new Error('installer must evaluate to a function');
        const disposer = factory(emit);
        if (typeof disposer !== 'function') throw new Error('installer must return a disposer function');
        // A specialized installer can expose a synchronous flush function on
        // its disposer. This is useful for debounced probes: reads then include
        // the final pending event instead of reporting a stale snapshot.
        const flush = typeof disposer.flush === 'function' ? disposer.flush.bind(disposer) : null;
        root[id] = { createdAt: Date.now(), maxEvents, captureRaw, maxRawEventBytes, coalesce, events, flush, dispose: disposer };
        return { id, installed: true, maxEvents, captureRaw, coalesce };
      })()
    `;
  }

  /** Install a named, disposable event probe in one renderer realm. */
  async installProbe(
    id: string,
    installer: string,
    maxEvents = 500,
    targetId?: string,
    options?: { captureRaw?: boolean; maxRawEventBytes?: number; coalesce?: boolean },
  ): Promise<unknown> {
    const script = this.buildProbeInstallScript(id, installer, maxEvents, options);
    return this.evaluateInTarget(script, targetId);
  }

  /**
   * Install the same probe into every current AND future window whose
   * webContents URL or title matches `urlPattern` (a RegExp source; omit to
   * match every window). Persists as an Electron main-process
   * `browser-window-created` listener, so a popout/prototype/child window
   * opened minutes later during the same Obsidian session still gets
   * instrumented automatically -- no manual re-injection per window like
   * obsidian_install_probe requires.
   *
   * Each matched window ends up with its own independent
   * window.__obsidianDevtoolsProbes[id] (same shape installProbe produces),
   * so obsidian_read_probe / obsidian_remove_probe / obsidian_list_probes
   * work unchanged against any of those targets once you have its targetId
   * (obsidian_list_targets). Removing the hook (obsidian_remove_window_probe)
   * stops future auto-injection but does not retroactively strip the probe
   * from windows it already reached.
   */
  async installWindowProbe(
    id: string,
    installer: string,
    urlPattern?: string,
    maxEvents = 500,
    options?: { captureRaw?: boolean; maxRawEventBytes?: number; coalesce?: boolean },
  ): Promise<unknown> {
    const rendererScript = this.buildProbeInstallScript(id, installer, maxEvents, options);
    const mainCode = `(() => {
      const { app, BrowserWindow } = require('electron');
      const registry = global.__obsidianDevtoolsWindowHooks || (global.__obsidianDevtoolsWindowHooks = Object.create(null));
      const id = ${JSON.stringify(id)};
      const urlPattern = ${urlPattern ? JSON.stringify(urlPattern) : 'null'};
      const script = ${JSON.stringify(rendererScript)};

      const previous = registry[id];
      if (previous) { try { app.removeListener('browser-window-created', previous.handler); } catch (e) {} }

      const matches = (win) => {
        if (!urlPattern) return true;
        try {
          const re = new RegExp(urlPattern);
          return re.test(win.webContents.getURL()) || re.test(win.getTitle());
        } catch (e) { return true; }
      };

      const inject = (win) => {
        try {
          const wc = win.webContents;
          const run = () => { if (matches(win)) wc.executeJavaScript(script).catch(() => {}); };
          if (wc.isLoading()) wc.once('did-finish-load', run); else run();
        } catch (e) {}
      };

      const handler = (event, win) => inject(win);
      app.on('browser-window-created', handler);

      const existing = BrowserWindow.getAllWindows();
      let matchedExisting = 0;
      for (const win of existing) { if (matches(win)) { inject(win); matchedExisting++; } }

      registry[id] = { handler, urlPattern, createdAt: Date.now() };
      return { id, installed: true, urlPattern, matchedExistingWindows: matchedExisting, totalWindows: existing.length };
    })()`;
    return this.evaluateMain(mainCode);
  }

  /** Stop future auto-injection for a window probe installed via installWindowProbe. Already-injected windows keep their probe until removeProbe/disconnect. */
  async removeWindowProbe(id: string): Promise<unknown> {
    return this.evaluateMain(`(() => {
      const { app } = require('electron');
      const registry = global.__obsidianDevtoolsWindowHooks || {};
      const entry = registry[${JSON.stringify(id)}];
      if (!entry) return { id: ${JSON.stringify(id)}, removed: false };
      try { app.removeListener('browser-window-created', entry.handler); } finally { delete registry[${JSON.stringify(id)}]; }
      return { id: ${JSON.stringify(id)}, removed: true };
    })()`);
  }

  /** List active window-probe hooks (main-process registry, not per-window buffers -- use listProbes(targetId) for those). */
  async listWindowProbes(): Promise<unknown> {
    return this.evaluateMain(`(() => {
      const registry = global.__obsidianDevtoolsWindowHooks || {};
      return Object.entries(registry).map(([id, entry]) => ({ id, urlPattern: entry.urlPattern, createdAt: entry.createdAt }));
    })()`);
  }

  async readProbe(id: string, options?: { since?: number; limit?: number; clear?: boolean; includeRaw?: boolean }, targetId?: string): Promise<unknown> {
    const limit = options?.limit == null ? null : Math.max(1, Math.min(10000, Math.floor(options.limit)));
    return this.evaluateInTarget(`
      (() => {
        const probe = window.__obsidianDevtoolsProbes?.[${JSON.stringify(id)}];
        if (!probe) return { id: ${JSON.stringify(id)}, installed: false, events: [] };
        try { probe.flush?.(); } catch (_) {}
        let events = probe.events.slice();
        ${options?.since != null ? `events = events.filter(e => e.timestamp >= ${Math.floor(options.since)});` : ''}
        ${limit != null ? `events = events.slice(-${limit});` : ''}
        events = events.map(({ signature, rawData, ...event }) => ${options?.includeRaw ? 'rawData === undefined ? event : { ...event, rawData }' : 'event'});
        const result = { id: ${JSON.stringify(id)}, installed: true, createdAt: probe.createdAt, events };
        ${options?.clear ? 'probe.events.length = 0;' : ''}
        return result;
      })()
    `, targetId);
  }

  async removeProbe(id: string, targetId?: string): Promise<unknown> {
    return this.evaluateInTarget(`
      (() => {
        const root = window.__obsidianDevtoolsProbes;
        const probe = root?.[${JSON.stringify(id)}];
        if (!probe) return { id: ${JSON.stringify(id)}, removed: false };
        try { probe.dispose(); } finally { delete root[${JSON.stringify(id)}]; }
        return { id: ${JSON.stringify(id)}, removed: true };
      })()
    `, targetId);
  }

  async listProbes(targetId?: string): Promise<unknown> {
    return this.evaluateInTarget(`
      (() => Object.entries(window.__obsidianDevtoolsProbes || {}).map(([id, probe]) => ({
        id, createdAt: probe.createdAt, bufferedEvents: probe.events.length, maxEvents: probe.maxEvents,
        captureRaw: probe.captureRaw, coalesce: probe.coalesce
      })))()
    `, targetId);
  }

  async waitFor<T>(predicate: string, timeoutMs = 5000, intervalMs = 100, targetId?: string): Promise<T> {
    const started = Date.now();
    let last: unknown;
    while (Date.now() - started < timeoutMs) {
      // Accept either a direct condition expression or a predicate function.
      // Returning the value lets CDP's awaitPromise option also support async
      // predicates without a separate polling path.
      last = await this.evaluateInTarget(`
        (() => {
          const candidate = (${predicate});
          return typeof candidate === 'function' ? candidate() : candidate;
        })()
      `, targetId);
      if (last) return last as T;
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, intervalMs)));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition. Last result: ${JSON.stringify(last)}`);
  }

  async captureScreenshot(options?: {
    selector?: string;
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
    targetId?: string;
  }): Promise<string> {
    const targetId = options?.targetId;
    const client = await this.getClient(targetId);

    let clip:
      | { x: number; y: number; width: number; height: number; scale: number }
      | undefined;

    // If selector provided, get element bounds
    if (options?.selector) {
      const bounds = await this.evaluateInTarget<{
        x: number;
        y: number;
        width: number;
        height: number;
      } | null>(`
        (function() {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()
      `, targetId);
      if (!bounds) {
        throw new Error('Element not found: ' + options.selector);
      }
      clip = { ...bounds, scale: 1 };
    }

    const result = await client.Page.captureScreenshot({
      format: options?.format || 'png',
      quality: options?.quality,
      clip,
    });

    return result.data; // base64 encoded
  }
}

// Singleton instance
export const obsidian = new ObsidianConnection();
