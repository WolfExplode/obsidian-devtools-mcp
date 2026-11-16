#!/usr/bin/env node
/**
 * Live integration checks against a running Obsidian.
 *
 * This server is almost entirely I/O against a real Electron app, so unit tests
 * would mostly assert that string templates are unchanged. These checks instead
 * exercise the real CDP path and assert on real renderer behaviour.
 *
 * Usage:
 *   npm run verify                 # read-only checks
 *   npm run verify -- --destructive # also mutate and restore an open Excalidraw board
 *
 * Obsidian must be running with --remote-debugging-port=9222.
 */
import { obsidian } from '../dist/connection.js';
import { CANVAS_HELPERS_JS, frameWatcherInstaller } from '../dist/renderer-scripts.js';
import { captureSceneSnapshot, restoreSceneSnapshot } from '../dist/scene-snapshot.js';

const DESTRUCTIVE = process.argv.includes('--destructive');
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  const suffix = detail === undefined ? '' : '  — ' + JSON.stringify(detail).slice(0, 240);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${suffix}`);
};
const skip = (name, why) => {
  console.log(`SKIP  ${name}  — ${why}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const info = await obsidian.connect(9222);
console.log(`connected to vault "${info.vaultName}"\n`);

// ---------------------------------------------------------------- user code
console.log('# evaluateUserCode: per-call scope, statements, expressions');
{
  // The papercut this fixes: at top level, a second call redeclaring the same
  // const failed with "Identifier 'out' has already been declared".
  const first = await obsidian.evaluateUserCode('const out = 41; return out + 1;');
  const second = await obsidian.evaluateUserCode('const out = "reused name"; return out;');
  check('statements returning a value, twice with the same declaration',
    first.value === 42 && second.value === 'reused name', { first: first.value, second: second.value });

  for (const [label, code, expected] of [
    ['bare expression', '1 + 1', 2],
    ['expression with a trailing semicolon', '1 + 1;', 2],
    ['IIFE with a trailing semicolon', '(() => ({ a: 1 }))();', { a: 1 }],
    ['object literal', '({ x: 5 })', { x: 5 }],
    ['top-level await', 'await Promise.resolve("awaited")', 'awaited'],
    ['undefined normalizes to null', 'undefined', null],
  ]) {
    const { value } = await obsidian.evaluateUserCode(code);
    check(label, JSON.stringify(value) === JSON.stringify(expected), { got: value });
  }

  try {
    await obsidian.evaluateUserCode('const = ;');
    check('malformed code reports a parse error', false, 'no error thrown');
  } catch (error) {
    check('malformed code reports a parse error', /Could not parse code/.test(error.message));
  }

  const { render } = await obsidian.evaluateUserCode('1');
  check('results carry render state', typeof render?.rafPaused === 'boolean', render);
}

// ------------------------------------------------------------- render state
console.log('\n# render state and frame pumping');
const render = await obsidian.getRenderState();
check('getRenderState reports visibility, focus and rAF state',
  typeof render.visibility === 'string' && typeof render.rafPaused === 'boolean', render);

{
  // The central claim: a hidden renderer stops firing rAF, and pumping frames
  // restarts it long enough to take a valid pixel reading.
  const canvases = await obsidian.evaluateInTarget(
    `(() => { ${CANVAS_HELPERS_JS} return $canvas('.excalidraw canvas'); })()`
  );
  const target = canvases.find((c) => c.opaquePixels > 0 && c.className.includes('overlay'))
    ?? canvases.find((c) => c.opaquePixels > 0);

  if (!target) {
    skip('pumpFrames drives a paused rAF loop', 'no painted canvas found in an Excalidraw view');
  } else if (!render.rafPaused) {
    skip('pumpFrames drives a paused rAF loop', 'Obsidian is focused, so rAF is not paused');
  } else {
    const selector = `.excalidraw canvas:nth-of-type(${target.index + 1})`;
    const opaque = async () => (await obsidian.evaluateUserCode(`
      const nodes = [...document.querySelectorAll('.excalidraw canvas')];
      const node = nodes[${target.index}];
      const d = node.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, node.width, node.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    `)).value;
    const clear = () => obsidian.evaluateUserCode(`
      const node = [...document.querySelectorAll('.excalidraw canvas')][${target.index}];
      const ctx = node.getContext('2d');
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, node.width, node.height); ctx.restore();
      return true;
    `);

    await clear();
    const blanked = await opaque();
    await sleep(400);
    const stillBlank = await opaque();
    check('a hidden renderer stays frozen without pumping (the trap this warns about)',
      blanked === 0 && stillBlank === 0, { selector, afterClear: blanked, after400ms: stillBlank });

    const pumped = await obsidian.pumpFrames(3);
    const repainted = await opaque();
    check('pumpFrames runs the paused rAF callbacks',
      repainted > 0, { framesPumped: pumped, opaqueAfterPump: repainted });
  }
}

// ----------------------------------------------------------- canvas helpers
console.log('\n# canvas helpers');
{
  const probe = await obsidian.evaluateInTarget(`(() => {
    ${CANVAS_HELPERS_JS}
    return { canvases: $canvas('.excalidraw canvas'), pixel: $pixel('.excalidraw canvas', 10, 10), render: $render() };
  })()`);
  check('$canvas measures every match in one call', Array.isArray(probe.canvases) && probe.canvases.length >= 1,
    probe.canvases.map((c) => ({ cls: c.className, opaque: c.opaquePixels, coverage: c.coveragePercent })));
  check('$canvas reports opaque counts and a content hash',
    probe.canvases.every((c) => typeof c.opaquePixels === 'number' && typeof c.hash === 'number'));
  check('$pixel returns RGBA at CSS coordinates', probe.pixel?.rgba?.length === 4, probe.pixel);

  const nonCanvas = await obsidian.evaluateInTarget(`(() => { ${CANVAS_HELPERS_JS} return $canvas('body'); })()`);
  check('a non-canvas match reports an error rather than throwing', nonCanvas[0]?.error === 'not-a-canvas');
  const absent = await obsidian.evaluateInTarget(`(() => { ${CANVAS_HELPERS_JS} return $canvas('.no-such-element'); })()`);
  check('a selector matching nothing returns an empty list', Array.isArray(absent) && absent.length === 0);
}

// -------------------------------------------------------- per-frame sampler
console.log('\n# per-frame sampler');
{
  const id = 'verify:frames';
  await obsidian.removeProbe(id).catch(() => {});
  const installed = await obsidian.installProbe(
    id, frameWatcherInstaller('({ vis: $render().visibility })', 1, 0), 200, undefined, { coalesce: true }
  );
  check('frame probe installs', installed?.installed === true);

  if (render.rafPaused) {
    await sleep(350);
    const idle = await obsidian.readProbe(id);
    check('samples nothing while hidden, because rAF is paused', (idle?.events?.length ?? 0) === 0);
  }

  const pumped = await obsidian.pumpFrames(6);
  await sleep(150);
  const sampled = await obsidian.readProbe(id);
  check('pumpFrames drives the sampler', (sampled?.events?.length ?? 0) > 0,
    { framesPumped: pumped, samples: sampled?.events?.length });
  check('samples carry a frame number and the expression value',
    typeof sampled?.events?.[0]?.data?.frame === 'number' && 'value' in (sampled?.events?.[0]?.data ?? {}),
    sampled?.events?.[0]?.data);
  check('frame probe removes cleanly', (await obsidian.removeProbe(id))?.removed === true);

  const capped = 'verify:frames-capped';
  await obsidian.removeProbe(capped).catch(() => {});
  await obsidian.installProbe(capped, frameWatcherInstaller('1', 1, 2), 50, undefined, { coalesce: false });
  await obsidian.pumpFrames(8);
  await sleep(150);
  const cappedRead = await obsidian.readProbe(capped);
  check('maxFrames self-stops the sampler', (cappedRead?.events?.length ?? 0) === 2,
    { samples: cappedRead?.events?.length });
  await obsidian.removeProbe(capped);

  const throwing = 'verify:frames-throw';
  await obsidian.removeProbe(throwing).catch(() => {});
  await obsidian.installProbe(throwing, frameWatcherInstaller('(() => { throw new Error("boom"); })()', 1, 2), 50, undefined, { coalesce: false });
  await obsidian.pumpFrames(6);
  await sleep(150);
  const threwRead = await obsidian.readProbe(throwing);
  check('a throwing expression becomes an error sample instead of killing the loop',
    threwRead?.events?.[0]?.data?.value?.error?.includes('boom') === true);
  await obsidian.removeProbe(throwing);
}

// ------------------------------------------------------- snapshot / restore
console.log('\n# Excalidraw scene snapshot and restore');
if (!DESTRUCTIVE) {
  skip('snapshot/restore round trip', 'pass --destructive to mutate and restore an open board');
} else {
  const readScene = async () => (await obsidian.evaluateUserCode(`
    const leaf = app.workspace.getLeavesOfType('excalidraw')[0];
    if (!leaf?.view?.excalidrawAPI) return null;
    const els = leaf.view.excalidrawAPI.getSceneElements();
    return { count: els.length, order: els.map(e => e.id), textX: els.filter(e => e.type === 'text').map(e => Math.round(e.x)) };
  `)).value;

  const original = await readScene();
  if (!original) {
    skip('snapshot/restore round trip', 'no Excalidraw view open');
  } else {
    const snapshot = await captureSceneSnapshot();
    check('snapshot captured', snapshot.elementCount === original.count,
      { token: snapshot.token, elements: snapshot.elementCount, bytes: snapshot.bytes });

    // Break it the three ways that actually happen: move things, delete
    // something, and rewrite z-order through fractional indices.
    await obsidian.evaluateUserCode(`
      const leaf = app.workspace.getLeavesOfType('excalidraw')[0];
      const els = leaf.view.excalidrawAPI.getSceneElements();
      const moved = els.slice(0, -1).map(e => e.type === 'text'
        ? { ...e, x: e.x + 777, version: (e.version || 0) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }
        : e);
      const embeds = moved.filter(e => e.type === 'embeddable');
      const rest = moved.filter(e => e.type !== 'embeddable');
      const reordered = [...rest, ...embeds].map(({ index, ...keep }) => keep);
      const synced = window.ExcalidrawLib?.syncInvalidIndices?.(reordered) ?? reordered;
      leaf.view.updateScene({ elements: synced, captureUpdate: 'IMMEDIATELY', commitToHistory: true });
      return true;
    `);
    const damaged = await readScene();
    check('the board really was damaged first',
      damaged.count !== original.count || damaged.order.join() !== original.order.join(),
      { countWas: original.count, countNow: damaged.count });

    const restored = await restoreSceneSnapshot(snapshot.token);
    check('restore reports success and verifies order', restored.restored && restored.orderMatches === true, restored);

    const after = await readScene();
    check('element count restored', after.count === original.count, { was: original.count, now: after.count });
    check('z-order restored exactly', after.order.join() === original.order.join());
    check('geometry restored exactly', JSON.stringify(after.textX) === JSON.stringify(original.textX),
      { was: original.textX, now: after.textX });

    check('the same token restores again (payload is on disk)',
      (await restoreSceneSnapshot(snapshot.token))?.orderMatches === true);
  }
}

try {
  await restoreSceneSnapshot('scene-does-not-exist');
  check('an unknown token errors clearly', false, 'no error thrown');
} catch (error) {
  check('an unknown token errors clearly', /No snapshot found/.test(error.message));
}

// ------------------------------------------------------------------ summary
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
const failed = results.filter((r) => !r.pass);
if (failed.length) console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
await obsidian.disconnect();
process.exit(failed.length ? 1 : 0);
