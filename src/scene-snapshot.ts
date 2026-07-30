import { mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { obsidian } from './connection.js';

/**
 * Restorable copies of Excalidraw scenes, so a destructive experiment on a real
 * vault can be undone exactly.
 *
 * This exists because of a specific near-miss: Excalidraw derives z-order from a
 * fractional `index` property, not from array position. So reordering the
 * elements array and writing it back appears to do nothing, while writing back
 * objects whose `index` was already rewritten silently reorders the board — and
 * both failure modes look identical from the outside. Anyone testing z-order
 * behaviour against a user's real file needs a guaranteed way back.
 *
 * Snapshots keep every element verbatim, `index` included, which is what makes a
 * restore exact rather than approximate.
 */

export interface SceneSnapshot {
  token: string;
  file: string;
  capturedAt: number;
  elementCount: number;
  path: string;
  bytes: number;
}

interface SnapshotPayload {
  file: string;
  elements: Array<{ id: string }>;
  viewport: { scrollX?: number; scrollY?: number; zoom?: number | null };
  capturedAt: number;
}

export interface RestoreResult {
  restored: boolean;
  reason?: string;
  file?: string;
  elementCount?: number;
  expectedCount?: number;
  /** Verified, not assumed — see the module comment on fractional indices. */
  orderMatches?: boolean;
  missingIds?: string[];
  unexpectedIds?: string[];
}

// Only the (small) index lives in memory; payloads go to disk so that an MCP
// restart is never what loses somebody's board.
const snapshots = new Map<string, SceneSnapshot>();
const SNAPSHOT_DIR = join(tmpdir(), 'obsidian-devtools-mcp-snapshots');
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

export function listSceneSnapshots(): SceneSnapshot[] {
  return [...snapshots.values()];
}

export async function captureSceneSnapshot(file?: string, targetId?: string): Promise<SceneSnapshot> {
  const captured = await obsidian.evaluateInTarget<{
    ok: boolean;
    reason?: string;
    candidates?: Array<string | null>;
    file?: string;
    elements?: Array<{ id: string }>;
    viewport?: SnapshotPayload['viewport'];
  }>(`(() => {
    const wanted = ${JSON.stringify(file ?? null)};
    const leaves = app.workspace.getLeavesOfType('excalidraw').filter(leaf => leaf.view?.excalidrawAPI);
    const paths = leaves.map(leaf => leaf.view?.file?.path ?? null);
    const leaf = wanted
      ? leaves.find(l => l.view?.file?.path === wanted)
      : (leaves.length === 1 ? leaves[0] : null);
    if (!leaf) {
      return { ok: false, candidates: paths,
        reason: wanted ? 'No open Excalidraw view for that file'
                       : 'Specify file: more than one (or no) Excalidraw view is open' };
    }
    const api = leaf.view.excalidrawAPI;
    const appState = api.getAppState?.() ?? {};
    return {
      ok: true,
      file: leaf.view.file?.path ?? null,
      // Verbatim, including index/version/versionNonce, so a restore is exact.
      elements: api.getSceneElements?.() ?? [],
      viewport: { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom?.value ?? null },
    };
  })()`, targetId);

  if (!captured.ok) {
    throw new Error(`${captured.reason}. Open Excalidraw views: ${JSON.stringify(captured.candidates ?? [])}`);
  }

  const payload = JSON.stringify({
    file: captured.file ?? '',
    elements: captured.elements ?? [],
    viewport: captured.viewport ?? {},
    capturedAt: Date.now(),
  } satisfies SnapshotPayload);

  if (payload.length > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `Scene is ${payload.length} bytes, over the ${MAX_SNAPSHOT_BYTES}-byte snapshot cap. ` +
      'Back the file up on disk instead of holding a copy this large in the MCP process.'
    );
  }

  const token = `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const path = join(SNAPSHOT_DIR, `${token}.json`);
  await writeFile(path, payload, 'utf8');

  const snapshot: SceneSnapshot = {
    token,
    file: captured.file ?? '(unsaved)',
    capturedAt: Date.now(),
    elementCount: (captured.elements ?? []).length,
    path,
    bytes: payload.length,
  };
  snapshots.set(token, snapshot);
  return snapshot;
}

export async function restoreSceneSnapshot(
  token: string,
  options?: { targetId?: string; restoreViewport?: boolean },
): Promise<RestoreResult> {
  const known = snapshots.get(token);
  const path = known?.path ?? join(SNAPSHOT_DIR, `${token}.json`);
  let payload: SnapshotPayload;
  try {
    payload = JSON.parse(await readFile(path, 'utf8')) as SnapshotPayload;
  } catch {
    throw new Error(`No snapshot found for token ${token}. Known tokens: ${JSON.stringify([...snapshots.keys()])}`);
  }

  return obsidian.evaluateInTarget<RestoreResult>(`(() => {
    const payload = ${JSON.stringify(payload)};
    const restoreViewport = ${options?.restoreViewport === true};
    const leaf = app.workspace.getLeavesOfType('excalidraw')
      .find(l => l.view?.file?.path === payload.file && l.view?.excalidrawAPI);
    if (!leaf) return { restored: false, reason: 'No open Excalidraw view for ' + payload.file };
    const view = leaf.view;
    // Obsidian's ExcalidrawView.updateScene (not the raw imperative API) is what
    // writes a scene as a single undoable history entry.
    const update = view.updateScene
      ? view.updateScene.bind(view)
      : view.excalidrawAPI.updateScene.bind(view.excalidrawAPI);
    update({ elements: payload.elements, captureUpdate: 'IMMEDIATELY', commitToHistory: true });
    if (restoreViewport && payload.viewport) {
      try {
        view.excalidrawAPI.updateScene({ appState: {
          scrollX: payload.viewport.scrollX, scrollY: payload.viewport.scrollY,
          ...(payload.viewport.zoom ? { zoom: { value: payload.viewport.zoom } } : {}),
        } });
      } catch (e) {}
    }
    const now = view.excalidrawAPI.getSceneElements?.() ?? [];
    const expectedOrder = payload.elements.map(e => e.id);
    const actualOrder = now.map(e => e.id);
    return {
      restored: true, file: payload.file,
      elementCount: actualOrder.length, expectedCount: expectedOrder.length,
      orderMatches: expectedOrder.join() === actualOrder.join(),
      missingIds: expectedOrder.filter(id => !actualOrder.includes(id)).slice(0, 20),
      unexpectedIds: actualOrder.filter(id => !expectedOrder.includes(id)).slice(0, 20),
    };
  })()`, options?.targetId);
}
