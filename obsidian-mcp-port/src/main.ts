import { Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import { startMcpPort, type RunningMcpPort } from './mcp-port';
import { DEBUG_PORT, inspectMainLaunch, scheduleDebugRelaunch, shouldRelaunch } from './debug-launch';

const DEFAULT_PORT = 27124;

export default class McpPortPlugin extends Plugin {
  private port = DEFAULT_PORT;
  private lastMainPid?: number;
  private running?: RunningMcpPort;

  async onload(): Promise<void> {
    const saved = await this.loadData() as { port?: unknown; lastMainPid?: unknown } | null;
    if (typeof saved?.port === 'number' && Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535) {
      this.port = saved.port;
    }
    if (typeof saved?.lastMainPid === 'number' && Number.isInteger(saved.lastMainPid)) {
      this.lastMainPid = saved.lastMainPid;
    }
    this.addSettingTab(new McpPortSettings(this));
    await this.start();
    await this.configureDebugLaunch();
  }

  async onunload(): Promise<void> {
    await this.running?.close();
    this.running = undefined;
  }

  private async start(): Promise<void> {
    try {
      this.running = await startMcpPort(this.app.vault, this.port);
      console.info(`[MCP Port] Listening at http://127.0.0.1:${this.port}/mcp`);
    } catch (error) {
      console.error('[MCP Port] Could not start server', error);
      new Notice(`MCP Port could not open port ${this.port}: ${String(error)}`);
    }
  }

  private async configureDebugLaunch(): Promise<void> {
    try {
      const state = inspectMainLaunch();
      const restart = shouldRelaunch(this.lastMainPid, state);
      this.lastMainPid = state.pid;
      await this.saveSettings();
      if (restart && scheduleDebugRelaunch()) {
        new Notice(`Restarting Obsidian with DevTools port ${DEBUG_PORT}…`);
      }
    } catch (error) {
      console.error('[MCP Port] Could not arrange DevTools launch', error);
      new Notice('MCP Port is active, but automatic DevTools launch is unavailable.');
    }
  }

  private async saveSettings(): Promise<void> {
    await this.saveData({ port: this.port, lastMainPid: this.lastMainPid });
  }

  async setPort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      new Notice('Choose a port from 1024 to 65535.');
      return;
    }
    if (port === this.port) return;
    const previousPort = this.port;
    await this.running?.close();
    this.running = undefined;
    this.port = port;
    await this.start();
    if (!this.running) {
      this.port = previousPort;
      await this.start();
      return;
    }
    await this.saveSettings();
  }

  getPort(): number { return this.port; }
  isListening(): boolean { return this.running !== undefined; }
}

class McpPortSettings extends PluginSettingTab {
  constructor(private readonly plugin: McpPortPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('MCP endpoint')
      .setDesc(this.plugin.isListening()
        ? `Listening at http://127.0.0.1:${this.plugin.getPort()}/mcp. Disable this plugin to close the port.`
        : 'The port is closed. Check the developer console for the startup error.');
    new Setting(containerEl)
      .setName('DevTools on launch')
      .setDesc(`After the next fresh launch, Obsidian will restart once with Electron debugging on port ${DEBUG_PORT}. The current session stays open.`);
    new Setting(containerEl)
      .setName('Port')
      .setDesc('Localhost only. Changing this restarts the MCP endpoint.')
      .addText((text) => {
        text.setPlaceholder(String(DEFAULT_PORT)).setValue(String(this.plugin.getPort()));
        text.inputEl.addEventListener('change', async () => {
          await this.plugin.setPort(Number(text.getValue()));
          this.display();
        });
      });
  }
}
