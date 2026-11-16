export const DEBUG_PORT = 9222;

export interface MainLaunchState {
  pid: number;
  args: string[];
}

function mainVm() {
  // Obsidian's desktop renderer exposes @electron/remote. Its vm proxy runs
  // code in Electron's main process, where process.argv is the launch command.
  const remote = require('@electron/remote') as { require(name: string): { runInThisContext(code: string): string } };
  return remote.require('vm');
}

export function inspectMainLaunch(): MainLaunchState {
  const json = mainVm().runInThisContext('JSON.stringify({ pid: process.pid, args: process.argv })');
  const state = JSON.parse(json) as MainLaunchState;
  if (!Number.isInteger(state.pid) || !Array.isArray(state.args)) throw new Error('Could not read Obsidian launch arguments.');
  return state;
}

export function hasDebugPort(args: string[]): boolean {
  return args.some((arg) => arg === '--remote-debugging-port' || arg.startsWith('--remote-debugging-port='));
}

export function shouldRelaunch(lastMainPid: number | undefined, state: MainLaunchState): boolean {
  // A new install or plugin reload stays in the current Obsidian session.
  return lastMainPid !== undefined && lastMainPid !== state.pid && !hasDebugPort(state.args);
}

export function scheduleDebugRelaunch(): boolean {
  // The guard lives in the main process so multiple vault windows cannot queue
  // multiple app.relaunch calls (which would launch multiple Obsidian instances).
  const code = `(() => {
    const key = Symbol.for('obsidian-mcp-port.debug-relaunch');
    if (globalThis[key]) return false;
    const Module = process.mainModule.constructor;
    const requireMain = Module.createRequire(process.mainModule.filename);
    const app = requireMain('electron').app;
    const args = process.argv.slice(1).filter(arg =>
      arg !== '--remote-debugging-port' && !arg.startsWith('--remote-debugging-port='));
    args.push('--remote-debugging-port=${DEBUG_PORT}');
    globalThis[key] = true;
    setTimeout(() => {
      app.relaunch({ args });
      app.quit();
    }, 1500);
    return true;
  })()`;
  return mainVm().runInThisContext(code) === 'true';
}
