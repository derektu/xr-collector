// The library a ticket flow imports: launch or attach an instance, drive it, record evidence.
export { attach, launchWeb, stopRun } from './instance.mjs';
export { apiState, openPage, recorder } from './drive.mjs';
export { launchElectron, recordOpenExternal, stubDialogs } from './electron.mjs';
export { articles, channel, channelUrl, defaultCatalog, REAL, videoUrl } from './synthetic.mjs';
export { collect, idle, subscribe } from './seed.mjs';
export { sleep, waitFor } from './wait.mjs';
