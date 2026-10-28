// 调试：打开导出模式页面，打印全部控制台输出，渲染一帧并统计像素
// 用法：node tools/dbg_page.mjs <scenes> <t>
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { acquireChromeLock } from './chrome_lock.mjs';

const [scenes = '', tt = '0'] = process.argv.slice(2);
const FPS = JSON.parse(fs.readFileSync(new URL('../script/timeline.json', import.meta.url))).fps || 30;
await acquireChromeLock({ label: 'dbg' });
const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1920, height: 1080 },
});
const p = await b.newPage();
p.on('console', (m) => console.log('[c]', m.type(), m.text().slice(0, 400)));
p.on('pageerror', (e) => console.log('[err]', e.message));
await p.goto(`http://127.0.0.1:5174/?capture=1&scenes=${scenes}`, { waitUntil: 'load' });
console.log(await p.evaluate(async () => { try { await window.__film.ready; return 'ready'; } catch (e) { return 'fail ' + e.message; } }));
const info = await p.evaluate((f) => {
  window.__film.renderFrame(f);
  const px = window.__film.readPixels();
  let s = 0, mx = 0;
  for (let i = 0; i < px.length; i += 4) { s += px[i]; if (px[i] > mx) mx = px[i]; }
  return { meanR: s / (px.length / 4), maxR: mx };
}, Math.round(parseFloat(tt) * FPS));
console.log(info);
console.log(await p.evaluate(() => JSON.stringify(window.__dbg || null)));
console.log(await p.evaluate(() => [...document.querySelectorAll('canvas')].map((c) => {
  let px = null;
  try { const g = c.getContext('2d'); if (g) px = Array.from(g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data); } catch (e) { px = 'webgl'; }
  return { w: c.width, h: c.height, px };
})));
await b.close();
