// 调试截图：先在页面里执行一段 JS（设全局调试开关），再渲染一帧截图
// 用法：node tools/dbg_shot.mjs <scenes> <t> <out.png> ["globalThis.__S4DBG=3"]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { acquireChromeLock } from './chrome_lock.mjs';

const [scenes = '', tt = '0', out = 'out/shots/dbg.png', pre = ''] = process.argv.slice(2);
const FPS = JSON.parse(fs.readFileSync(new URL('../script/timeline.json', import.meta.url))).fps || 30;
await acquireChromeLock({ label: 'dbgshot' });
const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1920, height: 1080 },
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[err]', e.message));
await p.goto(`http://127.0.0.1:5174/?capture=1&scenes=${scenes}`, { waitUntil: 'load' });
await p.evaluate(async () => { await window.__film.ready; });
if (pre) await p.evaluate(pre);
await p.evaluate((f) => { window.__film.renderFrame(f); }, Math.round(parseFloat(tt) * FPS));
const c = await p.$('canvas');
await c.screenshot({ path: out });
console.log('->', out);
await b.close();
