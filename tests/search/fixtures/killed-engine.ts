// A process for the leftover-engine test: it starts the bundled engine on a database, prints the
// engine's process ID and waits to be killed, leaving the engine behind.
// Arguments: <Meilisearch binary> <database directory>.
import { startMeilisearchProcess } from '../../../src/search/meilisearch-process.js';

const [binaryPath, databasePath] = process.argv.slice(2) as [string, string];
await startMeilisearchProcess({ binaryPath, databasePath });
const { pid } = JSON.parse(await (await import('node:fs/promises')).readFile(`${databasePath}.pid`, 'utf8')) as { pid: number };
console.log(`engine ${pid}`);
await new Promise<never>(() => undefined);
