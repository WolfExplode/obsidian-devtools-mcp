import assert from 'node:assert/strict';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import esbuild from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = fileURLToPath(new URL('.', import.meta.url));
class TFile { constructor(path) { this.path = path; } }
const files = new Map([['First.md', 'A starting note.']]);
const vault = {
  getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
  getAbstractFileByPath: (path) => files.has(path) ? new TFile(path) : null,
  read: async (file) => files.get(file.path),
  cachedRead: async (file) => files.get(file.path),
  process: async (file, fn) => { files.set(file.path, fn(files.get(file.path))); },
  create: async (path, content) => { files.set(path, content); },
};
const result = await esbuild.build({
  entryPoints: ['src/mcp-port.ts'], bundle: true, platform: 'node', format: 'cjs',
  packages: 'external', write: false,
});
const mockModule = new Module(`${here}/verify-bundle.cjs`);
mockModule.filename = `${here}/verify-bundle.cjs`;
mockModule.paths = Module._nodeModulePaths(here);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return { TFile, normalizePath: (path) => path };
  return originalLoad.call(this, request, parent, isMain);
};
try { mockModule._compile(result.outputFiles[0].text, mockModule.filename); }
finally { Module._load = originalLoad; }

const { startMcpPort } = mockModule.exports;
const port = 31000 + Math.floor(Math.random() * 10000);
const running = await startMcpPort(vault, port);
const client = new Client({ name: 'verify-client', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name), ['list_notes', 'read_note', 'search_notes', 'write_note']);
  const read = await client.callTool({ name: 'read_note', arguments: { path: 'First.md' } });
  assert.equal(read.content[0].text, 'A starting note.');
  await client.callTool({ name: 'write_note', arguments: { path: 'New.md', content: 'Hello from MCP.' } });
  assert.equal(files.get('New.md'), 'Hello from MCP.');
  const search = await client.callTool({ name: 'search_notes', arguments: { query: 'hello' } });
  assert.match(search.content[0].text, /New\.md/);
} finally {
  await client.close();
  await running.close();
}
await assert.rejects(fetch(`http://127.0.0.1:${port}/mcp`));

// Load the installable bundle from a path with no node_modules ancestry.
class Plugin {
  static saved = { port };
  app = { vault };
  async loadData() { return Plugin.saved; }
  async saveData(data) { Plugin.saved = data; }
  addSettingTab() {}
}
class PluginSettingTab { constructor() {} }
class Setting {}
class Notice {}
let relaunches = 0;
let relaunchArgs;
let quits = 0;
const remote = { require: () => ({ runInThisContext: (code) => {
  if (code.startsWith('JSON.stringify')) return JSON.stringify({ pid: 1001, args: ['Obsidian.exe'] });
  const fakeApp = {
    relaunch: ({ args }) => { relaunches++; relaunchArgs = args; },
    quit: () => { quits++; },
  };
  return String(runInNewContext(code, {
    process: {
      argv: ['Obsidian.exe'],
      mainModule: { filename: 'obsidian-main.js', constructor: { createRequire: () => () => ({ app: fakeApp }) } },
    },
    setTimeout: (fn) => fn(),
    Symbol,
  }));
} }) };
const installedModule = new Module(join(tmpdir(), 'obsidian-mcp-port-verify', 'main.js'));
installedModule.filename = join(tmpdir(), 'obsidian-mcp-port-verify', 'main.js');
installedModule.paths = Module._nodeModulePaths(join(tmpdir(), 'obsidian-mcp-port-verify'));
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return { Plugin, PluginSettingTab, Setting, Notice, TFile, normalizePath: (path) => path };
  if (request === '@electron/remote') return remote;
  return originalLoad.call(this, request, parent, isMain);
};
installedModule._compile(readFileSync(new URL('./main.js', import.meta.url), 'utf8'), installedModule.filename);
const InstalledPlugin = installedModule.exports.default;
const installed = new InstalledPlugin();
await installed.onload();
assert.equal(relaunches, 0, 'first enable should not restart Obsidian');
const installedClient = new Client({ name: 'verify-installed', version: '1.0.0' });
try {
  await installedClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const read = await installedClient.callTool({ name: 'read_note', arguments: { path: 'New.md' } });
  assert.equal(read.content[0].text, 'Hello from MCP.');
} finally {
  await installedClient.close();
  await installed.onunload();
}
await assert.rejects(fetch(`http://127.0.0.1:${port}/mcp`));
Plugin.saved = { port, lastMainPid: 1000 };
const laterLaunch = new InstalledPlugin();
await laterLaunch.onload();
assert.equal(relaunches, 1, 'a later fresh launch should arrange one debug restart');
assert.deepEqual(relaunchArgs, ['--remote-debugging-port=9222']);
assert.equal(quits, 1);
await laterLaunch.onunload();
Module._load = originalLoad;
console.log('MCP endpoint verified: connect, list, read, write, search, close, standalone bundle, debug relaunch scheduling.');
