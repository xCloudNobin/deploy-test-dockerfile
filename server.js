import { createApp, TaskBoardStore } from './app.js';
import { loadConfig } from './lib/config.js';

const config = loadConfig();
let store = null;
let openError = null;

try {
  store = new TaskBoardStore(config.databasePath);
  console.log(`[db] sqlite ready at ${config.databasePath} (${store.probe() ? 'probe ok' : 'probe failed'})`);
} catch (err) {
  openError = err;
  console.error(`[db] failed to open database at ${config.databasePath}: ${err.message}`);
}

const app = createApp({ store, config });
const server = app.listen(config.port, config.host, () => {
  console.log(`${config.appName} v${config.version} listening on ${config.host}:${config.port}`);
  console.log(`[build] ${config.buildMarker}`);
  if (openError) console.warn('[warn] running without database; /ready and /api will report 503');
});

function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing server`);
  server.close(() => {
    if (store) {
      try {
        store.close();
        console.log('[shutdown] database closed');
      } catch (err) {
        console.error('[shutdown] database close error:', err.message);
      }
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[shutdown] force exit after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));