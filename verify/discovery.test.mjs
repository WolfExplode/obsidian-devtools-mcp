import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { discoverTargets } from '../dist/discovery.js';
import { ObsidianConnection, findMainTarget } from '../dist/connection.js';

async function endpoint(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

test('empty HTTP failures retain endpoint, status and collision recovery guidance', async t => {
  const port = await endpoint(t, (_, response) => { response.writeHead(404); response.end(); });
  await assert.rejects(discoverTargets(port), error => {
    assert.match(error.message, new RegExp(`127.0.0.1:${port}/json/list`));
    assert.match(error.message, /HTTP 404/);
    assert.match(error.message, /another app owns this port/);
    assert.match(error.message, /27124.*separate/);
    return true;
  });
});

test('non-DevTools JSON and malformed responses reject rather than throwing in an HTTP callback', async t => {
  for (const payload of ['<html>wrong endpoint</html>', '{}', '[{"id":1}]']) {
    const port = await endpoint(t, (_, response) => response.end(payload));
    await assert.rejects(discoverTargets(port), /not a DevTools target list/);
  }
});

test('discovery has a total deadline and limits response size', async t => {
  const stalled = await endpoint(t, (_, response) => { response.writeHead(200); response.write('['); });
  await assert.rejects(discoverTargets(stalled, 50), /timed out after 50 ms/);
  const large = await endpoint(t, (_, response) => response.end(' '.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(discoverTargets(large), /exceeds 2 MiB/);
});

test('valid discovery stays read-only and a browser without Obsidian is diagnosed', async t => {
  const requests = [];
  const target = { id: 'browser-tab', type: 'page', title: 'Example', url: 'https://example.com' };
  const port = await endpoint(t, (request, response) => { requests.push([request.method, request.url]); response.end(JSON.stringify([target])); });
  assert.deepEqual(await discoverTargets(port), [target]);
  const connection = new ObsidianConnection();
  await assert.rejects(connection.connect(port), /no Obsidian main window.*another browser/);
  assert.equal(connection.isConnected(), false);
  assert.deepEqual(requests, [['GET', '/json/list'], ['GET', '/json/list']]);
});

test('invalid ports and refused sockets report actionable errors', async t => {
  for (const port of [0, -1, 65536, 1.5, NaN]) assert.throws(() => discoverTargets(port), /integer from 1 to 65535/);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(discoverTargets(port), /Cannot discover Obsidian.*ECONNREFUSED/);
});

test('an empty DevTools handshake error names the Obsidian port', async t => {
  const port = await endpoint(t, (request, response) => {
    if (request.url === '/json/list') {
      response.end(JSON.stringify([{ id: 'obsidian', type: 'page', title: 'Obsidian', url: 'app://obsidian.md/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/obsidian` }]));
    } else { response.writeHead(404); response.end(); }
  });
  const connection = new ObsidianConnection();
  await assert.rejects(connection.connect(port), new RegExp(`Could not attach to Obsidian DevTools on port ${port}: empty handshake error`));
  assert.equal(connection.isConnected(), false);
});

test('the vault renderer takes precedence over a settings window', () => {
  const targets = [
    { id: 'settings', type: 'page', title: 'Settings - docs - Obsidian', url: 'about:blank' },
    { id: 'vault', type: 'page', title: 'docs - Obsidian', url: 'app://obsidian.md/index.html' },
  ];
  assert.equal(findMainTarget(targets).id, 'vault');
});

test('the MCP tool surfaces HTTP failures without a blank Error response', async t => {
  const port = await endpoint(t, (_, response) => { response.writeHead(404); response.end(); });
  const client = new Client({ name: 'discovery-verification', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], stderr: 'pipe' }));
    const result = await client.callTool({ name: 'obsidian_connect', arguments: { port } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /HTTP 404/);
    assert.match(result.content[0].text, /MCP Port settings/);
  } finally { await client.close(); }
});
