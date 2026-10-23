// Stands in for a run's server.mts. The first one to receive SIGTERM while XR_TEST_SWEEP_ARMED
// exists starts the sweeper in this server's process group and exits; the restart that sent SIGTERM waits
// for the group to empty, so the sweep runs after this server is gone and before the next one starts.
// Once the handler is installed, the server creates <XR_TEST_READY>/<pid>.
import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  const armed = process.env.XR_TEST_SWEEP_ARMED;
  try {
    renameSync(armed, `${armed}.used`);
    spawn(process.execPath, [path.join(import.meta.dirname, 'sweeper.mjs'), String(process.pid)], { stdio: 'ignore' });
  } catch { /* not armed: a plain shutdown */ }
  process.exit(0);
});
writeFileSync(path.join(process.env.XR_TEST_READY, String(process.pid)), '');
