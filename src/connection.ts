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
