// Starts the web app on the example monorepo and captures the images used in the README.
// Needs a local Chromium: set CHROMIUM_PATH or let playwright-core find one.
import { chromium } from 'playwright-core';
import { serve } from '../dist/index.js';

const server = await serve({ root: 'examples/shop', port: 0, watch: false });
const base = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const shots = [
  { file: 'docs/app-packages.png', scheme: 'light', hash: '#/packages', click: '.node[data-id="pkg:@shop/web"]' },
  { file: 'docs/app-components.png', scheme: 'dark', hash: '#/components?pkg=%40shop%2Fapi', click: '.node[data-id="cmp:@shop/api:src/routes"]' },
];
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, colorScheme: shot.scheme, deviceScaleFactor: 2 });
  await page.goto(base + shot.hash);
  await page.waitForSelector('#live.on');
  await page.waitForSelector('.canvas svg');
  if (shot.click) await page.click(shot.click);
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot.file, type: 'png' });
  await page.close();
  console.log(shot.file);
}
await browser.close();
server.close();
