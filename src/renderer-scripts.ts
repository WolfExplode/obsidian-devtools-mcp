/**
 * Renderer-side script builders: JavaScript that is shipped into the page
 * rather than run here. Kept out of index.ts so the strings can be exercised
 * directly by a harness without booting the MCP server on stdio.
 */

/**
 * Shared renderer-side helpers made available to canvas probes and per-frame
 * samplers. Written once here because hand-rolling "count the non-transparent
 * pixels / hash this canvas" per call produced five slightly different versions
 * in one session, one of which read a stale element reference and sent a real
 * investigation down a blind alley.
 */
export const CANVAS_HELPERS_JS = `
  const $canvas = (selector) => {
    const nodes = [...document.querySelectorAll(selector)];
    return nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const base = {
        index, selector,
        className: (node.className || '').toString().slice(0, 80),
        bitmap: [node.width, node.height],
        css: [Math.round(rect.width), Math.round(rect.height)],
        connected: node.isConnected,
      };
      if (!(node instanceof HTMLCanvasElement)) return { ...base, error: 'not-a-canvas' };
      if (!node.width || !node.height) return { ...base, empty: true };
      let data;
      try {
        data = node.getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, node.width, node.height).data;
      } catch (error) {
        // A canvas tainted by cross-origin content cannot be read back at all.
        return { ...base, error: 'unreadable: ' + (error && error.name || 'unknown') };
      }
      let opaque = 0;
      let hash = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
      // Sampled rather than exhaustive: enough to tell "did these pixels change"
      // across frames without the cost of hashing every byte every frame.
      for (let i = 0; i < data.length; i += 4093) hash = (hash * 33 + data[i]) >>> 0;
      return { ...base, opaquePixels: opaque, coveragePercent: +(100 * opaque / (node.width * node.height)).toFixed(2), hash };
    });
  };
  const $pixel = (selector, x, y) => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLCanvasElement)) return null;
    const dpr = window.devicePixelRatio || 1;
    try {
      const d = node.getContext('2d', { willReadFrequently: true })
        .getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return { at: [x, y], dpr, rgba: [d[0], d[1], d[2], d[3]] };
    } catch (error) { return { at: [x, y], error: String(error && error.name) }; }
  };
  const $render = () => ({
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    rafPaused: document.visibilityState === 'hidden',
  });
`;

/**
 * A probe that samples an expression once per animation frame.
 *
 * This is the frame-accurate counterpart to the event probes: it exists so that
 * "does this render correctly *while* the user drags something" can be answered
 * without driving the gesture synthetically. Scripted input is explicitly the
 * wrong tool for that — it can look successful while testing something else — so
 * the workflow is install this, ask the user to perform the gesture, then read
 * the buffer back.
 *
 * Because it is rAF-driven it samples nothing while the window is hidden, which
 * is correct: that is also when the feature under test isn't rendering.
 */
export function frameWatcherInstaller(expression: string, sampleEvery = 1, maxFrames = 0): string {
  return `(emit) => {
    ${CANVAS_HELPERS_JS}
    const sampleEvery = ${Math.max(1, Math.floor(sampleEvery))};
    const maxFrames = ${Math.max(0, Math.floor(maxFrames))};
    const sample = () => (${expression});
    let frame = 0;
    let sampled = 0;
    let handle = 0;
    let stopped = false;
    const step = () => {
      if (stopped) return;
      frame++;
      if (frame % sampleEvery === 0) {
        sampled++;
        let value;
        try { value = sample(); }
        catch (error) { value = { error: String((error && error.message) || error) }; }
        emit({ frame, sampled, at: Math.round(performance.now()), value });
        if (maxFrames && sampled >= maxFrames) { stopped = true; return; }
      }
      handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => { stopped = true; cancelAnimationFrame(handle); };
  }`;
}
