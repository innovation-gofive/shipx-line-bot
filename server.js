require('dotenv').config({ quiet: true });
const { loadConfig } = require('./src/config');
const { Store } = require('./src/store');
const { ShipXClient } = require('./src/shipx');
const { LineClient } = require('./src/line');
const { createApp } = require('./src/app');
async function main() {
  const config = loadConfig(process.env, process.argv.includes('--demo'));
  const store = new Store(config.databasePath);
  if (config.demo) store.seedDemo();
  const shipx = new ShipXClient(config), line = new LineClient(config);
  const { app, worker } = await createApp({ config, store, shipx, line });
  const server = app.listen(config.port, '0.0.0.0', () => console.log('ShipX LINE Bot: http://localhost:' + config.port + (config.demo ? ' (DEMO)' : ' (live)')));
  worker.start();
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 23000).unref();
    const serverClosed = new Promise(resolve => server.close(resolve));
    await Promise.all([worker.stop(), serverClosed]);
    store.close();
    clearTimeout(deadline);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
