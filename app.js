import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApiRouter, ApiError } from './routes/api.js';
import { loadConfig } from './lib/config.js';
import { TaskBoardStore } from './lib/db.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)));

export function createApp({ store, config = loadConfig() } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/', (_req, res) => {
    res.sendFile(join(rootDir, 'public', 'index.html'));
  });

  app.get('/app', (_req, res) => {
    res.sendFile(join(rootDir, 'public', 'index.html'));
  });

  app.use(express.static(join(rootDir, 'public')));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', app: config.appName });
  });

  app.get('/ready', (_req, res) => {
    if (!store) {
      res.status(503).json({
        status: 'unavailable',
        dependencies: { database: 'down' },
        error: 'database is not connected',
      });
      return;
    }
    try {
      const ok = store.probe();
      if (!ok) throw new Error('database probe failed');
      res.json({
        status: 'ok',
        dependencies: { database: 'up' },
        build: config.buildMarker,
      });
    } catch (err) {
      console.error('[ready] database unavailable:', err.message);
      res.status(503).json({
        status: 'unavailable',
        dependencies: { database: 'down' },
        error: 'database is unavailable',
      });
    }
  });

  app.get('/api/info', (req, res) => {
    res.json({
      app: config.appName,
      runtime: 'node',
      framework: 'express',
      version: config.version,
      build: config.buildMarker,
    });
  });

  app.use('/api', (req, res, next) => {
    if (!store) {
      res.status(503).json({ error: 'database is not connected', code: 'db_unavailable' });
      return;
    }
    next();
  });
  app.use('/api', createApiRouter(store));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'endpoint not found' });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid JSON body' });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request body too large' });
      return;
    }
    console.error('[error]', err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

export { TaskBoardStore };