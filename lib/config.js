import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitHead() {
  try {
    const head = readFileSync(join(rootDir, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      const refPath = head.slice(5).trim();
      return readFileSync(join(rootDir, '.git', refPath), 'utf8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return 'no-git';
  }
}

function portFrom(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT ${JSON.stringify(value)}.`);
  }
  return port;
}

export function loadConfig(env = process.env) {
  const version = readVersion();
  const gitRef = readGitHead();
  const buildMarker =
    env.BUILD_MARKER && env.BUILD_MARKER.trim()
      ? env.BUILD_MARKER.trim()
      : `local-${gitRef.split(' ').pop().slice(0, 7)}-${version}`;

  return {
    host: env.HOST ?? '0.0.0.0',
    port: portFrom(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? join(rootDir, 'data', 'taskboard.sqlite'),
    buildMarker,
    version,
    appName: 'deploy-test-dockerfile',
  };
}