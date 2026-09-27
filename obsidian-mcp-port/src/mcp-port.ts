import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { normalizePath, TFile, type Vault } from 'obsidian';

export interface RunningMcpPort {
  close(): Promise<void>;
}

function notePath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Use a relative vault path without . or .. segments.');
  }
  const normalized = normalizePath(path);
  if (!normalized.toLowerCase().endsWith('.md') || normalized.startsWith('.obsidian/')) {
    throw new Error('Only Markdown notes inside the vault are supported.');
  }
  return normalized;
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

function makeMcpServer(vault: Vault): McpServer {
  const server = new McpServer({ name: 'obsidian-mcp-port', version: '0.2.0' });

  server.registerTool('list_notes', {
    description: 'List Markdown note paths in the current Obsidian vault.',
    inputSchema: { prefix: z.string().optional() },
  }, async ({ prefix }) => {
    const paths = vault.getMarkdownFiles().map((file) => file.path).sort();
    return textResult(prefix ? paths.filter((path) => path.startsWith(prefix)) : paths);
  });

  server.registerTool('read_note', {
    description: 'Read a Markdown note by its vault-relative path.',
    inputSchema: { path: z.string() },
  }, async ({ path }) => {
    const file = vault.getAbstractFileByPath(notePath(path));
    if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
    return textResult(await vault.read(file));
  });

  server.registerTool('search_notes', {
    description: 'Search Markdown note contents, returning matching paths and line excerpts (up to 50 results).',
    inputSchema: { query: z.string().min(1) },
  }, async ({ query }) => {
    const needle = query.toLowerCase();
    const matches: Array<{ path: string; line: number; excerpt: string }> = [];
    for (const file of vault.getMarkdownFiles()) {
      const lines = (await vault.cachedRead(file)).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ path: file.path, line: i + 1, excerpt: lines[i].slice(0, 300) });
          if (matches.length === 50) return textResult(matches);
        }
      }
    }
    return textResult(matches);
  });

  server.registerTool('write_note', {
    description: 'Create or replace a Markdown note at a vault-relative path. Existing content is overwritten.',
    inputSchema: { path: z.string(), content: z.string() },
  }, async ({ path, content }) => {
    const normalized = notePath(path);
    const existing = vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await vault.process(existing, () => content);
      return textResult({ path: normalized, action: 'updated' });
    }
    if (existing) throw new Error(`Path is not a file: ${normalized}`);
    await vault.create(normalized, content);
    return textResult({ path: normalized, action: 'created' });
  });

  return server;
}

export async function startMcpPort(vault: Vault, port: number): Promise<RunningMcpPort> {
  const httpServer: HttpServer = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const mcp = makeMcpServer(vault);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    });
    response.once('close', () => { void mcp.close(); });
    void mcp.connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch((error: unknown) => {
        console.error('[MCP Port] Request failed', error);
        if (!response.headersSent) response.writeHead(500).end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  return {
    close: () => new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
      httpServer.closeAllConnections();
    }),
  };
}
