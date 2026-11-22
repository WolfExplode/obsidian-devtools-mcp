import { get } from 'node:http';
import type CDP from 'chrome-remote-interface';

export function validateDebugPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DevTools port must be an integer from 1 to 65535.');
  }
}

/** Read-only discovery with bounded time/data and errors that retain HTTP status.
 * chrome-remote-interface discards the status and throws Error(body), which is
 * blank when another application's endpoint sends an empty 404.
 */
export function discoverTargets(port: number, timeoutMs = 5000): Promise<CDP.Target[]> {
  validateDebugPort(port);
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const hint = 'Check that Obsidian was started with --remote-debugging-port=' + port +
    '. If another app owns this port, choose a free DevTools port in MCP Port settings, ' +
    'start Obsidian normally again, then call obsidian_connect with that port. ' +
    'The note MCP endpoint (normally 27124) is separate from DevTools.';
  return new Promise((resolve, reject) => {
    const fail = (reason: string) => new Error(`Cannot discover Obsidian at ${endpoint}: ${reason}. ${hint}`);
    const request = get(endpoint, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(fail(`HTTP ${response.statusCode ?? 'unknown'}`));
        request.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { request.destroy(fail('target list exceeds 2 MiB')); return; }
        chunks.push(chunk);
      });
      response.on('error', error => reject(fail(error.message || 'response interrupted')));
      response.on('end', () => {
        try {
          const targets: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(targets) || !targets.every(t => t && typeof t === 'object' &&
            typeof t.id === 'string' && typeof t.type === 'string' && typeof t.title === 'string' && typeof t.url === 'string')) {
            throw new Error('invalid target list');
          }
          resolve(targets as CDP.Target[]);
        } catch { reject(fail('response is not a DevTools target list')); }
      });
    });
    // Total deadline, including a peer that keeps sending bytes without finishing.
    const timer = setTimeout(() => request.destroy(fail(`timed out after ${timeoutMs} ms`)), timeoutMs);
    request.on('error', error => reject(error.message.startsWith('Cannot discover Obsidian') ? error : fail(error.message || 'connection failed')));
    request.on('close', () => clearTimeout(timer));
  });
}
