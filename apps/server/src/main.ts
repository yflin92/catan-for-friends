// Production process entry (design §11, deploy/README.md). Reads its process settings from the environment, starts the
// server, and drains on SIGTERM/SIGINT before exiting (ADR-0005). Every other setting comes from HEXLANDS_* config
// variables (design §3.9), read by startServer.
//   HEXLANDS_PORT           listen port (default 8080; only the compose network reaches it)
//   HEXLANDS_DB_PATH        SQLite file (default /data/hexlands.db)
//   HEXLANDS_BUILD_VERSION  the deploy's git SHA: /healthz version, room.buildVersion and OTel service.version (D12)
import { startServer } from './server';
import { exitOnShutdownSignals } from './shutdown';

const env = process.env;
const port = Number(env['HEXLANDS_PORT'] ?? '8080');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HEXLANDS_PORT must be an integer port');

const server = await startServer({
  port,
  dbPath: env['HEXLANDS_DB_PATH'] ?? '/data/hexlands.db',
  buildVersion: env['HEXLANDS_BUILD_VERSION'] ?? 'dev',
});
exitOnShutdownSignals(server);
