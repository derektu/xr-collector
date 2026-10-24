// The library a ticket flow imports: launch or attach an instance, drive it, record evidence.
export { attach, launchWeb, stopRun } from './instance.mjs';
export { openPage, recorder } from './drive.mjs';
export { apiState, readState } from './state.mjs';
export { clickTray, closeWindow, launchElectron, notifications, recordOpenExternal, stubDialogs, trayMenu, windowState } from './electron.mjs';
export { articles, channel, channelUrl, defaultCatalog, REAL, videoUrl } from './synthetic.mjs';
export { collect, idle, subscribe } from './seed.mjs';
export { sleep, waitFor } from './wait.mjs';
