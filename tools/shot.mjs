// 抽帧检查：用系统 Chrome 无头打开导出模式，渲染指定时间点，存 PNG，可选拼成带时间码的联系表
// 用法: node tools/shot.mjs --times 10,20.5,30 [--scenes s0_cold] [--out out/shots] [--sheet name] [--cols 3] [--full]
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireChromeLock } from './chrome_lock.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);

const base = opt('url', 'http://127.0.0.1:5174');
const FPS = JSON.parse(fs.readFileSync(new URL('../script/timeline.json', import.meta.url))).fps || 30;
const scenes = opt('scenes', '');
const out = opt('out', 'out/shots');
const times = opt('times', '1').split(',').map(Number);
const sheet = opt('sheet', '');
const cols = parseInt(opt('cols', '3'), 10);
const tag = opt('tag', 'f');
fs.mkdirSync(out, { recursive: true });

export async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1920,1080', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    protocolTimeout: 600000,
  });
}

await acquireChromeLock({ label: `shot ${sheet || tag}` });
const browser = await launch();
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[dbg]')) console.log('[page]', m.type(), m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const q = new URLSearchParams({ capture: '1' });
if (scenes) q.set('scenes', scenes);
const t0 = Date.now();
await page.goto(`${base}/?${q}`, { waitUntil: 'load', timeout: 300000 });
await page.evaluate(() => window.__film.ready);
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const files = [];
for (const t of times) {
  const s = Date.now();
  await page.evaluate((f) => window.__film.renderFrame(f), Math.round(t * FPS));
  const file = path.join(out, `${tag}_${t.toFixed(2).padStart(7, '0')}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  files.push({ file, t });
  console.log(`t=${t} ${Date.now() - s}ms -> ${file}`);
}
await browser.close();

if (sheet) {
  const dst = path.join(out, `${sheet}.png`);
  execFileSync('.venv/bin/python', ['tools/sheet.py', dst, String(cols), ...files.map(({ file, t }) => `${file}:${t.toFixed(2)}`)]);
  if (!flag('full')) for (const { file } of files) fs.unlinkSync(file);
  console.log('sheet ->', dst);
}
