import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TaskBoardStore } from '../app.js';
import { createApp } from '../app.js';
import { startServer, withStore, cleanup, jsonRequest, tempDbPath, dirOf } from './helpers.mjs';

let ctx;
let baseUrl;
let close;

before(async () => {
  ctx = withStore();
  const server = await startServer({ store: ctx.store, config: { appName: 'deploy-test-dockerfile' } });
  baseUrl = server.baseUrl;
  close = server.close;
});

after(async () => {
  await close();
  ctx.store.close();
  cleanup(ctx.dir);
});

test('home page serves the task board HTML', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /TaskBoard/);
  assert.match(html, /New project/i);
});

test('health endpoint stays compatible', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', app: 'deploy-test-dockerfile' });
});

test('readiness reports ok with a live database', async () => {
  const res = await fetch(`${baseUrl}/ready`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.dependencies.database, 'up');
});

test('seed data is present and idempotent', async () => {
  const { body } = await jsonRequest(baseUrl, '/api/projects');
  assert.equal(body.projects.length > 0, true);
  const first = body.projects[0];
  assert.equal(typeof first.name, 'string');
  const { body: tasks } = await jsonRequest(baseUrl, '/api/tasks');
  assert.equal(tasks.tasks.length > 0, true);
  assert.ok(['todo', 'in_progress', 'done'].includes(tasks.tasks[0].status));
});

test('project CRUD round trip', async () => {
  const created = await jsonRequest(baseUrl, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'API Project', description: 'from test' }),
  });
  assert.equal(created.status, 201);
  const project = created.body.project;
  assert.equal(project.name, 'API Project');

  const gotten = await jsonRequest(baseUrl, `/api/projects/${project.id}`);
  assert.equal(gotten.status, 200);
  assert.equal(gotten.body.project.name, 'API Project');

  const patched = await jsonRequest(baseUrl, `/api/projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'API Project v2' }),
  });
  assert.equal(patched.body.project.name, 'API Project v2');

  const deleted = await jsonRequest(baseUrl, `/api/projects/${project.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);

  const after = await jsonRequest(baseUrl, `/api/projects/${project.id}`);
  assert.equal(after.status, 404);
});

test('task CRUD round trip with status', async () => {
  const proj = await jsonRequest(baseUrl, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Tasks Project' }),
  });
  const projectId = proj.body.project.id;

  const created = await jsonRequest(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, title: 'Write tests', status: 'in_progress' }),
  });
  assert.equal(created.status, 201);
  const task = created.body.task;
  assert.equal(task.status, 'in_progress');

  const gotten = await jsonRequest(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(gotten.body.task.title, 'Write tests');

  const patched = await jsonRequest(baseUrl, `/api/tasks/${task.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'done', title: 'Write all the tests' }),
  });
  assert.equal(patched.body.task.status, 'done');
  assert.equal(patched.body.task.title, 'Write all the tests');

  const deleted = await jsonRequest(baseUrl, `/api/tasks/${task.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);

  const afterDelete = await jsonRequest(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(afterDelete.status, 404);
});

test('deleting a project cascades its tasks', async () => {
  const proj = await jsonRequest(baseUrl, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cascade Project' }),
  });
  const projectId = proj.body.project.id;
  await jsonRequest(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, title: 'to-cascade' }),
  });

  await jsonRequest(baseUrl, `/api/projects/${projectId}`, { method: 'DELETE' });

  const list = await jsonRequest(baseUrl, '/api/tasks?projectId=' + projectId);
  assert.equal(list.status, 404);
});

test('search and status filters work', async () => {
  const proj = await jsonRequest(baseUrl, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Filter Project' }),
  });
  const projectId = proj.body.project.id;
  await jsonRequest(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, title: 'Alpha task', status: 'todo' }),
  });
  await jsonRequest(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, title: 'Beta task', status: 'done' }),
  });

  const q = await jsonRequest(baseUrl, '/api/tasks?q=Alpha');
  assert.equal(q.status, 200);
  assert.equal(q.body.tasks.length, 1);
  assert.equal(q.body.tasks[0].title, 'Alpha task');

  const doneOnly = await jsonRequest(baseUrl, '/api/tasks?status=done');
  assert.ok(doneOnly.body.tasks.every((t) => t.status === 'done'));
});

test('validation errors return 400', async () => {
  const emptyTitle = await jsonRequest(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ project_id: 1, title: '   ' }),
  });
  assert.equal(emptyTitle.status, 400);
  assert.match(emptyTitle.body.error, /must not be empty/i);

  const missingTitle = await jsonRequest(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ project_id: 1 }),
  });
  assert.equal(missingTitle.status, 400);

  const badStatus = await jsonRequest(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ project_id: 1, title: 'ok', status: 'shipped' }),
  });
  assert.equal(badStatus.status, 400);

  const missingProject = await jsonRequest(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'orphan' }),
  });
  assert.equal(missingProject.status, 400);

  const badProject = await jsonRequest(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ project_id: 999999, title: 'orphan' }),
  });
  assert.equal(badProject.status, 404);

  const emptyProjectName = await jsonRequest(baseUrl, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '' }),
  });
  assert.equal(emptyProjectName.status, 400);

  const badQueryStatus = await jsonRequest(baseUrl, '/api/tasks?status=bad');
  assert.equal(badQueryStatus.status, 400);
});

test('malformed JSON returns 400', async () => {
  const res = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /invalid JSON/i);
});

test('unknown routes return 404 JSON', async () => {
  const res = await fetch(`${baseUrl}/api/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'endpoint not found');

  const missing = await fetch(`${baseUrl}/api/tasks/999999`);
  assert.equal(missing.status, 404);
});

test('non-object body returns 400', async () => {
  const res = await jsonRequest(baseUrl, '/api/projects', {
    method: 'POST',
    body: JSON.stringify(['not', 'an', 'object']),
  });
  assert.equal(res.status, 400);
});

test('readiness and API fail when store is unavailable', async () => {
  const degraded = await startServer({ store: null });
  try {
    const ready = await fetch(`${degraded.baseUrl}/ready`);
    assert.equal(ready.status, 503);
    const readyBody = await ready.json();
    assert.equal(readyBody.dependencies.database, 'down');

    const health = await fetch(`${degraded.baseUrl}/health`);
    assert.equal(health.status, 200);

    const api = await fetch(`${degraded.baseUrl}/api/projects`);
    assert.equal(api.status, 503);
  } finally {
    await degraded.close();
  }
});

test('data persists across a store reopen (same file)', async () => {
  const path = tempDbPath();
  const dir = dirOf(path);
  const s1 = new TaskBoardStore(path);
  const proj = s1.db
    .prepare('INSERT INTO projects (name) VALUES (?)')
    .run('Persistent Project').lastInsertRowid;
  s1.close();

  const s2 = new TaskBoardStore(path);
  try {
    const row = s2.db.prepare('SELECT name FROM projects WHERE id = ?').get(proj);
    assert.equal(row.name, 'Persistent Project');
    const stillSeeded = s2.db
      .prepare('SELECT COUNT(*) AS n FROM projects WHERE name = ?')
      .get('Persistent Project');
    assert.equal(stillSeeded.n, 1);
  } finally {
    s2.close();
    cleanup(dir);
  }
});

test('seed does not duplicate on reopen', async () => {
  const path = tempDbPath();
  const dir = dirOf(path);
  const s1 = new TaskBoardStore(path);
  const before = s1.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  s1.close();
  const s2 = new TaskBoardStore(path);
  const after = s2.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  assert.equal(after, before);
  s2.close();
  cleanup(dir);
});

test('createApp with a store returns a working app', async () => {
  const app = createApp({ store: ctx.store });
  const res = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      fetch(`http://127.0.0.1:${port}/ready`).then((r) => {
        server.close(() => resolve(r));
      });
    });
  });
  assert.equal(res.status, 200);
});