// Renders the example viewer and captures the image used in the README.
// Needs a local Chromium: set CHROMIUM_PATH or let playwright-core find one.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { buildModel, checkRules, loadConfig, renderViewer } from '../dist/index.js';

const root = 'examples/shop';
const config = loadConfig(root);
const model = buildModel(root, config);
const html = join(tmpdir(), 'arch-map-example.html');
writeFileSync(html, renderViewer(model, config, checkRules(model, config)));
mkdirSync('docs', { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const shots = [
  { file: 'docs/viewer.png', scheme: 'light' },
  { file: 'docs/viewer-detail.png', scheme: 'dark', select: '@shop/web' },
];
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, colorScheme: shot.scheme, deviceScaleFactor: 2 });
  await page.goto(`file://${html}`);
  if (shot.select) await page.click(`.node[data-id="pkg:${shot.select}"]`);
  if (shot.violation !== undefined) await page.click(`.violation >> nth=${shot.violation}`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot.file, type: 'png' });
  await page.close();
  console.log(shot.file);
}
await browser.close();
