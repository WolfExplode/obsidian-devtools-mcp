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

export class ObsidianConnection {
  private client: CDP.Client | null = null;
  private consoleLogs: ConsoleEntry[] = [];
  private connected = false;
  private readonly MAX_LOG_ENTRIES = 1000;

  isConnected(): boolean {
    return this.connected && this.client !== null;
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

    this.client = await CDP({ port, target: mainTarget.id });

    // Enable necessary domains
    await this.client.Runtime.enable();
    await this.client.Page.enable();

    // Set up console log capture
    this.client.Runtime.consoleAPICalled((params) => {
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

      this.consoleLogs.push({
        timestamp: Date.now(),
        level: params.type,
        message: args.join(' '),
        args: params.args,
        stackTrace: params.stackTrace,
      });

      // Keep buffer bounded
      if (this.consoleLogs.length > this.MAX_LOG_ENTRIES) {
        this.consoleLogs.shift();
      }
    });

    // Handle disconnection
    this.client.on('disconnect', () => {
      this.connected = false;
      this.client = null;
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

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
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
    clear?: boolean;
  }): ConsoleEntry[] {
    let logs = [...this.consoleLogs];

    // Filter by timestamp
    if (options?.since) {
      logs = logs.filter((log) => log.timestamp >= options.since!);
    }

    // Filter by level
    if (options?.level && options.level !== 'all') {
      logs = logs.filter((log) => log.level === options.level);
    }

    // Limit results
    if (options?.limit) {
      logs = logs.slice(-options.limit);
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

  async captureScreenshot(options?: {
    selector?: string;
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
  }): Promise<string> {
    if (!this.client) {
      throw new Error('Not connected to Obsidian');
    }

    let clip:
      | { x: number; y: number; width: number; height: number; scale: number }
      | undefined;

    // If selector provided, get element bounds
    if (options?.selector) {
      const bounds = await this.evaluate<{
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
      `);
      if (!bounds) {
        throw new Error('Element not found: ' + options.selector);
      }
      clip = { ...bounds, scale: 1 };
    }

    const result = await this.client.Page.captureScreenshot({
      format: options?.format || 'png',
      quality: options?.quality,
      clip,
    });

    return result.data; // base64 encoded
  }
}

// Singleton instance
export const obsidian = new ObsidianConnection();
