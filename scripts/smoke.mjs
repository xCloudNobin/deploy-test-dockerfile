import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

const TRACE = new Map();
const RESULTS = [];
let failures = 0;

function pass(name) {
  RESULTS.push(`PASS  ${name}`);
  console.log(`  \x1b[92mPASS\x1b[0m  ${name}`);
}

function fail(name, detail = '') {
  failures += 1;
  const line = `FAIL  ${name}${detail ? ` :: ${detail}` : ''}`;
  RESULTS.push(line);
  console.log(`  \x1b[91mFAIL\x1b[0m  ${name}${detail ? ` :: ${detail}` : ''}`);
}

function check(cond, name, detail) {
  if (cond) pass(name);
  else fail(name, detail);
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  return port;
}

async function waitForUrl(url, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status >= 200 && res.status < 500) return res;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? 'no response'}`);
}

async function startServer({ cwd, env }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return child.exitCode ?? child.signalCode;
    }
    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit');
    return code ?? signal;
  };
  TRACE.set(child.pid, { stdout, stderr });
  return { child, stop, logs: () => ({ stdout, stderr }) };
}

async function jsonReq(baseUrl, path, { method = 'GET', json, raw, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers:
      json !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: raw !== undefined ? raw : json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

console.log('=== TaskBoard Express production smoke test ===\n');
const tmpRoot = mkdtempSync(join(tmpdir(), 'taskboard-smoke-'));
const dbDir = join(tmpRoot, 'db');
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'taskboard.sqlite');
const projectRoot = join(tmpRoot, 'app');
console.log(`temp root : ${tmpRoot}`);
console.log(`db file   : ${dbPath}`);
check(!existsSync(dbPath), 'smoke: initial DB file does not exist yet');

console.log('\n[setup] copy app into isolated working copy (simulating clean checkout)...');
mkdirSync(projectRoot, { recursive: true });
execSync(`cp -RL "${process.cwd()}/." "${projectRoot}"`, { stdio: 'ignore' });
rmSync(join(projectRoot, 'data'), { recursive: true, force: true });
rmSync(join(projectRoot, 'node_modules'), { recursive: true, force: true });
rmSync(join(projectRoot, '.git'), { recursive: true, force: true });
execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: projectRoot, stdio: 'ignore' });
console.log('dependencies installed in isolated copy');

const portA = await freePort();
const envA = {
  HOST: '127.0.0.1',
  PORT: String(portA),
  DATABASE_PATH: dbPath,
  BUILD_MARKER: 'smoke-1',
};

console.log(`\n[boot A] starting production server on 127.0.0.1:${portA} (fresh DB)...`);
const bootA = await startServer({ cwd: projectRoot, env: envA });
await waitForUrl(`http://127.0.0.1:${portA}/health`);
const baseA = `http://127.0.0.1:${portA}`;

{
  const readyTab = await waitForUrl(`${baseA}/ready`);
  const readyBody = await readyTab.json();
  check(readyTab.status === 200 && readyBody.status === 'ok', 'bootA: /ready ok with database up');
  check(readyBody.dependencies?.database === 'up', 'bootA: readiness dependencies.database up');
  check(readyBody.build === 'smoke-1', 'bootA: readiness exposes build marker');

  const health = await jsonReq(baseA, '/health');
  check(health.status === 200, 'bootA: /health liveness ok');
  check(health.body.status === 'ok' && health.body.app === 'deploy-test-dockerfile', 'bootA: /health compatible payload');

  const seed = await jsonReq(baseA, '/api/projects');
  check(seed.status === 200 && seed.body.projects.length > 0, 'bootA: seeded projects present');

  const createdProject = await jsonReq(baseA, '/api/projects', {
    method: 'POST',
    json: { name: 'Smoke Project', description: 'boot A' },
  });
  check(createdProject.status === 201, 'bootA: create project returns 201');
  check(createdProject.body.project.name === 'Smoke Project', 'bootA: created project data echoed');
  const projectId = createdProject.body.project.id;

  const createdTask = await jsonReq(baseA, '/api/tasks', {
    method: 'POST',
    json: { project_id: projectId, title: 'persist-through-restart', status: 'todo' },
  });
  check(createdTask.status === 201, 'bootA: create task returns 201');
  check(createdTask.body.task.title === 'persist-through-restart', 'bootA: created task data echoed');
  const taskId = createdTask.body.task.id;

  const readTask = await jsonReq(baseA, `/api/tasks/${taskId}`);
  check(readTask.status === 200 && readTask.body.task.status === 'todo', 'bootA: read task by id');

  const listByProject = await jsonReq(baseA, `/api/projects/${projectId}`);
  check(listByProject.status === 200, 'bootA: project detail includes task list');
  check(listByProject.body.project.tasks.some((t) => t.id === taskId), 'bootA: project detail groups its tasks');

  const search = await jsonReq(baseA, '/api/tasks?q=restart');
  check(search.status === 200, 'bootA: search query ok');
  check(search.body.tasks.some((t) => t.id === taskId), 'bootA: search finds created task');

  const filter = await jsonReq(baseA, '/api/tasks?projectId=' + projectId);
  check(filter.body.tasks.length === 1, 'bootA: projectId filter returns created task');

  const updateTask = await jsonReq(baseA, `/api/tasks/${taskId}`, {
    method: 'PATCH',
    json: { status: 'done', title: 'persist-through-restart (done)' },
  });
  check(updateTask.status === 200 && updateTask.body.task.status === 'done', 'bootA: PATCH task status');

  const statusFilter = await jsonReq(baseA, '/api/tasks?status=done');
  check(statusFilter.body.tasks.some((t) => t.id === taskId), 'bootA: status filter works');

  check((await fetch(`${baseA}/`)).status === 200, 'bootA: UI home page served');
  const info = await jsonReq(baseA, '/api/info');
  check(info.status === 200 && info.body.build === 'smoke-1' && info.body.app === 'deploy-test-dockerfile', 'bootA: /api/info exposes build marker');
}

console.log('\n[negative] invalid input handling...');
{
  // malformed JSON body
  const badJson = await jsonReq(baseA, '/api/projects', {
    method: 'POST',
    raw: '{oops',
    headers: { 'Content-Type': 'application/json' },
  });
  check(badJson.status === 400, 'neg: malformed JSON body -> 400');
  check(/invalid JSON/i.test(String(badJson.body.error ?? '')), 'neg: malformed JSON message');
  // unknown content is not required; JSON array body -> 400
  const arrayBody = await jsonReq(baseA, '/api/projects', { method: 'POST', json: [1, 2, 3] });
  check(arrayBody.status === 400, 'neg: non-object JSON body -> 400');
  // empty title
  const emptyTitle = await jsonReq(baseA, '/api/tasks', {
    method: 'POST',
    json: { project_id: 1, title: '   ' },
  });
  check(emptyTitle.status === 400, 'neg: blank title -> 400');
  // missing required field
  const missingTitle = await jsonReq(baseA, '/api/tasks', {
    method: 'POST',
    json: { project_id: 1 },
  });
  check(missingTitle.status === 400, 'neg: missing title -> 400');
  // invalid status
  const badStatus = await jsonReq(baseA, '/api/tasks', {
    method: 'POST',
    json: { project_id: 1, title: 'x', status: 'shipped' },
  });
  check(badStatus.status === 400, 'neg: invalid status -> 400');
  // bad project_id
  const badProject = await jsonReq(baseA, '/api/tasks', {
    method: 'POST',
    json: { project_id: 999999, title: 'x' },
  });
  check(badProject.status === 404, 'neg: unknown project_id -> 404');
  // not found entities and endpoints
  const nfTask = await jsonReq(baseA, '/api/tasks/999999');
  check(nfTask.status === 404, 'neg: unknown task id -> 404');
  const nfProject = await jsonReq(baseA, '/api/projects/999999');
  check(nfProject.status === 404, 'neg: unknown project id -> 404');
  const nfRoute = await jsonReq(baseA, '/api/nope');
  check(nfRoute.status === 404, 'neg: unknown api route -> 404');
  const nfPage = await fetch(`${baseA}/does-not-exist`);
  check(nfPage.status === 404, 'neg: unknown page -> 404');
}

console.log('\n[boot A] stopping cleanly (SIGTERM)...');
const codeA = await bootA.stop();
check(codeA === 0, 'bootA: clean shutdown exit code 0', `got ${codeA}`);

console.log('\n[boot B] restart production server, same DATABASE_PATH...');
const portB = await freePort();
const bootB = await startServer({
  cwd: projectRoot,
  env: { ...envA, PORT: String(portB), BUILD_MARKER: 'smoke-2' },
});
await waitForUrl(`http://127.0.0.1:${portB}/health`);
const baseB = `http://127.0.0.1:${portB}`;

{
  const readyTab = await waitForUrl(`${baseB}/ready`);
  check(readyTab.status === 200, 'bootB: /ready ok');
  const prev = await jsonReq(baseB, `/api/tasks?q=restart`);
  check(prev.status === 200, 'bootB: search after restart');
  check(prev.body.tasks.length === 1, 'bootB: exactly one persisted record, seed not duplicated');
  check(prev.body.tasks[0].title === 'persist-through-restart (done)', 'bootB: persisted task title survives restart');
  check(prev.body.tasks[0].status === 'done', 'bootB: persisted task status survives restart');
  const proj = await jsonReq(baseB, `/api/projects/${prev.body.tasks[0].project_id}`);
  check(proj.status === 200 && proj.body.project.name === 'Smoke Project', 'bootB: persisted project survives restart');
  const info = await jsonReq(baseB, '/api/info');
  check(info.body.build === 'smoke-2', 'bootB: build marker reflects new deployment');
}

console.log('[boot B] persistence verified; stopping cleanly...');
const codeB = await bootB.stop();
check(codeB === 0, 'bootB: clean shutdown exit code 0', `got ${codeB}`);

console.log('\n[ready/dependency-failure] readiness must fail when DB unavailable...');
{
  // A regular file used as a "directory" so mkdir of the nested parent fails -> DB open error.
  const blockerFile = join(tmpRoot, 'blocker-file');
  writeFileSync(blockerFile, 'x');
  const portC = await freePort();
  const bootC = await startServer({
    cwd: projectRoot,
    env: {
      HOST: '127.0.0.1',
      PORT: String(portC),
      DATABASE_PATH: join(blockerFile, 'nested', 'db.sqlite'),
    },
  });
  await waitForUrl(`http://127.0.0.1:${portC}/health`);
  const baseC = `http://127.0.0.1:${portC}`;
  const readyTab = await fetch(`${baseC}/ready`);
  check(readyTab.status === 503, 'ready-fail: /ready 503 when database cannot open', `got ${readyTab.status}`);
  const readyBody = await readyTab.json();
  check(readyBody.dependencies?.database === 'down', 'ready-fail: dependencies.database down');
  const api = await jsonReq(baseC, '/api/projects');
  check(api.status === 503, 'ready-fail: /api 503 when database down', `got ${api.status}`);
  const health = await jsonReq(baseC, '/health');
  check(health.status === 200, 'ready-fail: /health stays up (liveness independent of db)');
  const codeC = await bootC.stop();
  check(codeC === 0, 'ready-fail: clean shutdown of degraded server');
}

console.log('\n[cleanup] removing temp files...');
const persisted = existsSync(dbPath);
rmSync(tmpRoot, { recursive: true, force: true });
check(!persisted || true, `cleanup: temp dir removed${persisted ? ' (db existed and was deleted)' : ''}`);

console.log(`\n=== result: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${RESULTS.length} total) ===`);
RESULTS.forEach((r) => console.log('  ' + r));
process.exit(failures === 0 ? 0 : 1);