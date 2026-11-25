import { setTimeout as sleep } from 'node:timers/promises';
import { setInterval as every } from 'timers';

setTimeout(() => undefined, 10);
setInterval(() => undefined, 10);
globalThis.setTimeout(() => undefined, 10);
window.setInterval(() => undefined, 10);
await sleep(10);
every(() => undefined, 10);
