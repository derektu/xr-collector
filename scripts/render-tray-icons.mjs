// Renders the tray icons into resources/tray/ with Playwright's Chromium:
//   node scripts/render-tray-icons.mjs
// macOS takes black template images (tray-<state>Template.png, 18 pt with an @2x), which the menu
// bar tints for light and dark; Windows takes colored ones (tray-<state>.png, 16 px with an @2x).
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'tray');

const layers = (stroke) => `<path d="M12 3l9 5-9 5-9-5 9-5z" stroke="${stroke}"/><path d="M3 13l9 5 9-5" stroke="${stroke}"/>`;
const macBadges = {
  idle: '',
  collecting: '<circle cx="19.5" cy="18.5" r="3" fill="#000"/>',
  auto_check_off: '<path d="M18 16v5M21 16v5" stroke="#000" stroke-width="2"/>',
};
const mac = (state) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${layers('#000')}${macBadges[state]}</svg>`;

const winTile = { idle: '#6BA6DF', collecting: '#6BA6DF', auto_check_off: '#7C8799' };
const winBadges = {
  idle: '',
  collecting: '<circle cx="19.5" cy="19.5" r="4" fill="#FFFFFF" stroke="#202020" stroke-width="1.5"/>',
  auto_check_off: '',
};
const win = (state) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="1" width="22" height="22" rx="6" fill="${winTile[state]}"/><g transform="translate(2.4 2.6) scale(0.8)">${layers('#0C1322')}</g>${winBadges[state]}</svg>`;

const icons = [];
for (const state of Object.keys(macBadges)) {
  icons.push({ name: `tray-${state}Template.png`, svg: mac(state), size: 18 });
  icons.push({ name: `tray-${state}Template@2x.png`, svg: mac(state), size: 36 });
  icons.push({ name: `tray-${state}.png`, svg: win(state), size: 16 });
  icons.push({ name: `tray-${state}@2x.png`, svg: win(state), size: 32 });
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { name, svg, size } of icons) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(output, name), omitBackground: true });
    console.log(name);
  }
} finally {
  await browser.close();
}
