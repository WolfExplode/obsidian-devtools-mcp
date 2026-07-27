export type Toolset = 'core' | 'diagnostics' | 'full';

export type RegisteredTool = { name: string };

type ToolsetDefinition = {
  useFor: string;
  keywords: readonly string[];
  additionalTools: readonly string[];
};

const TOOLSETS: Record<Toolset, ToolsetDefinition> = {
  core: {
    useFor: 'connect, reload plugins, inspect errors, run renderer JavaScript, and inspect commands, vaults, and plugin settings',
    keywords: ['connect', 'reload', 'plugin', 'console', 'error', 'command', 'vault', 'setting', 'renderer', 'javascript'],
    additionalTools: [],
  },
  diagnostics: {
    useFor: 'event probes, Excalidraw reproduction reports, popouts, Electron windows, screenshots, workspace leaves, and plugin diagnostics',
    keywords: ['excalidraw', 'probe', 'event', 'timeline', 'popout', 'window', 'screenshot', 'leaf', 'workspace', 'diagnostic'],
    additionalTools: [
      'obsidian_list_targets', 'obsidian_install_probe', 'obsidian_read_probe',
      'obsidian_watch_excalidraw', 'obsidian_start_excalidraw_bug_window',
      'obsidian_finish_excalidraw_bug_window', 'obsidian_get_diagnostic_timeline',
      'obsidian_remove_probe', 'obsidian_list_probes', 'obsidian_get_native_windows',
      'obsidian_get_excalidraw_state', 'obsidian_list_leaves',
      'obsidian_get_plugin_diagnostics', 'obsidian_capture_screenshot',
    ],
  },
  full: {
    useFor: 'main-process JavaScript plus plugin store and embedded-MCP inspection; it includes every tool',
    keywords: ['main process', 'main-process', 'require.cache', 'store', 'svelte', 'embedded mcp', 'plugin mcp', 'bridge'],
    additionalTools: [
      'obsidian_execute_js_main', 'obsidian_get_store_state',
      'obsidian_call_plugin_mcp',
    ],
  },
};

const TOOLSET_ORDER: readonly Toolset[] = ['core', 'diagnostics', 'full'];

/**
 * The tool registry is the seam between the MCP protocol and this server's
 * capability taxonomy. Its interface answers the questions an agent needs:
 * which tools are visible, what work each profile is for, and which profile a
 * task needs. Tool handlers stay in index.ts for now; moving that large
 * implementation separately would not improve this interface.
 */
export class ToolRegistry<T extends RegisteredTool> {
  private readonly byName: ReadonlyMap<string, T>;
  private readonly namesByToolset: ReadonlyMap<Toolset, ReadonlySet<string>>;

  constructor(tools: readonly T[], coreToolNames: readonly string[]) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
    if (this.byName.size !== tools.length) throw new Error('Tool names must be unique');

    const namesByToolset = new Map<Toolset, ReadonlySet<string>>();
    let visible = new Set(coreToolNames);
    for (const toolset of TOOLSET_ORDER) {
      for (const name of TOOLSETS[toolset].additionalTools) visible.add(name);
      this.assertKnown(visible, toolset);
      namesByToolset.set(toolset, new Set(visible));
    }
    const unclassified = [...this.byName.keys()]
      .filter((name) => !namesByToolset.get('full')!.has(name));
    if (unclassified.length) {
      throw new Error(`Every tool must be classified: ${unclassified.join(', ')}`);
    }
    this.namesByToolset = namesByToolset;
  }

  normalize(value: string | undefined): Toolset {
    return value === 'diagnostics' || value === 'full' ? value : 'core';
  }

  list(toolset: Toolset): T[] {
    const names = this.namesByToolset.get(toolset)!;
    return [...this.byName.values()].filter((tool) => names.has(tool.name));
  }

  has(toolset: Toolset, name: string): boolean {
    return this.namesByToolset.get(toolset)?.has(name) ?? false;
  }

  discover(task?: string): {
    recommendedToolset: Toolset;
    matches: Array<{ toolset: Toolset; useFor: string; additionalTools: readonly string[] }>;
  } {
    const query = task?.toLowerCase() ?? '';
    const matches: Toolset[] = TOOLSET_ORDER.filter((toolset) =>
      TOOLSETS[toolset].keywords.some((keyword) => query.includes(keyword))
    );
    const recommendedToolset = matches.includes('full')
      ? 'full'
      : matches.includes('diagnostics')
        ? 'diagnostics'
        : 'core';
    const matchedToolsets: Toolset[] = matches.length ? matches : ['core'];
    return {
      recommendedToolset,
      matches: matchedToolsets.map((toolset) => ({
        toolset,
        useFor: TOOLSETS[toolset].useFor,
        additionalTools: TOOLSETS[toolset].additionalTools,
      })),
    };
  }

  catalog(): Record<Toolset, { useFor: string; additionalTools: readonly string[] }> {
    return Object.fromEntries(TOOLSET_ORDER.map((toolset) => [toolset, {
      useFor: TOOLSETS[toolset].useFor,
      additionalTools: TOOLSETS[toolset].additionalTools,
    }])) as Record<Toolset, { useFor: string; additionalTools: readonly string[] }>;
  }

  private assertKnown(names: ReadonlySet<string>, toolset: Toolset): void {
    const unknown = [...names].filter((name) => !this.byName.has(name));
    if (unknown.length) throw new Error(`Unknown ${toolset} tools: ${unknown.join(', ')}`);
  }
}
