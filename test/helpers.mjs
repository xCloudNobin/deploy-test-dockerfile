import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, TaskBoardStore } from '../app.js';

export function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'taskboard-test-'));
  return join(dir, 'test.sqlite');
}

export function cleanup(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function dirOf(path) {
  return path.replace(/\/[^/]+$/, '');
}

export async function startServer({ store = null, config } = {}) {
  const app = createApp({ store, config });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { baseUrl, close, app };
}

export function withStore() {
  const dbPath = tempDbPath();
  const store = new TaskBoardStore(dbPath);
  return { store, dbPath, dir: dirOf(dbPath) };
}

export async function jsonRequest(baseUrl, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}