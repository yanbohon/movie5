// 逐帧导出整片：多个无头 Chrome 分段渲染，像素经 WebSocket 直送 ffmpeg，最后拼接并混入音轨
// 用法: node tools/render.mjs [--from 0] [--to 440] [--workers 3] [--crf 16] [--url http://127.0.0.1:4173] [--audio out/audio/mix.wav] [--out out/重构.mp4]
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireChromeLock } from './chrome_lock.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const TL = JSON.parse(fs.readFileSync(new URL('../script/timeline.json', import.meta.url)));
const W = 1920, H = 1080, FPS = TL.fps || 30;
const from = parseFloat(opt('from', '0')), to = parseFloat(opt('to', String(TL.duration)));
const workers = parseInt(opt('workers', '3'), 10);
const crf = opt('crf', '16');
const base = opt('url', 'http://127.0.0.1:5174');
const audio = opt('audio', '');
const outFile = opt('out', 'out/鲔.mp4');
const scenes = opt('scenes', '');
// 整个导出期间独占 Chrome 锁（它自己会开多个 Chrome，别的截图进程排队）
await acquireChromeLock({ label: `render ${from}-${to}`, minFree: 35 });
const segDir = path.resolve('out/segments');
fs.mkdirSync(segDir, { recursive: true });

const f0 = Math.round(from * FPS), f1 = Math.round(to * FPS);
const total = f1 - f0;
const per = Math.ceil(total / workers);
const PORT = 8765;
const wss = new WebSocketServer({ port: PORT, maxPayload: 64 * 1024 * 1024 });
const pending = new Map(); // workerId -> resolve(buffer)
wss.on('connection', (ws) => {
  let id = null;
  ws.on('message', (data, isBinary) => {
    if (!isBinary) { id = String(data); return; }
    const r = pending.get(id);
    if (r) { pending.delete(id); r(data); }
  });
});

let done = 0;
const tStart = Date.now();
function progress() {
  done++;
  if (done % 60 === 0 || done === total) {
    const el = (Date.now() - tStart) / 1000;
    const fps = done / el;
    process.stdout.write(`\r${done}/${total} frames  ${fps.toFixed(1)} fps  eta ${((total - done) / fps / 60).toFixed(1)} min   `);
  }
}

async function runWorker(k, a, b) {
  const seg = path.join(segDir, `seg_${String(k).padStart(2, '0')}.mp4`);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-vf', 'vflip', '-c:v', 'libx264', '-preset', 'slow', '-tune', 'grain', '-crf', crf, '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', seg], { stdio: ['pipe', 'inherit', 'inherit'] });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 0,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1920,1080', '--force-device-scale-factor=1'],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`\n[w${k} pageerror]`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`\n[w${k}]`, m.text()); });
  const q = new URLSearchParams({ capture: '1' });
  if (scenes) q.set('scenes', scenes);
  await page.goto(`${base}/?${q}`, { waitUntil: 'load', timeout: 0 });
  await page.evaluate(() => window.__film.ready);
  const wid = `w${k}`;
  await page.evaluate((port, wid) => new Promise((res) => {
    window.__ws = new WebSocket(`ws://127.0.0.1:${port}`);
    window.__ws.binaryType = 'arraybuffer';
    window.__ws.onopen = () => { window.__ws.send(wid); res(); };
  }), PORT, wid);
  for (let f = a; f < b; f++) {
    const got = new Promise((res) => pending.set(wid, res));
    await page.evaluate((f) => {
      window.__film.renderFrame(f);
      window.__ws.send(window.__film.readPixels());
    }, f);
    const buf = await got;
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    progress();
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  // Chrome 的 crashpad 子进程在主进程关掉后会变成孤儿、抓着继承来的管道不放，node 因此不退出：关之前记下，关完杀掉
  const cpid = browser.process()?.pid;
  let pads = [];
  try { pads = execFileSync('pgrep', ['-P', String(cpid), '-f', 'chrome_crashpad_handler'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { /* 没有 */ }
  await browser.close();
  for (const pid of pads) { try { process.kill(pid); } catch { /* 已经没了 */ } }
  return seg;
}

const jobs = [];
for (let k = 0; k < workers; k++) {
  const a = f0 + k * per, b = Math.min(f1, a + per);
  if (a < b) jobs.push(runWorker(k, a, b));
}
const segs = await Promise.all(jobs);
wss.close();
console.log(`\nrendered ${total} frames in ${((Date.now() - tStart) / 60000).toFixed(1)} min`);

const list = path.join(segDir, 'list.txt');
fs.writeFileSync(list, segs.map((s) => `file '${s}'`).join('\n'));
const video = path.join(segDir, 'video.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
if (audio && fs.existsSync(audio)) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-ss', String(from), '-t', String(to - from), '-i', audio,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', outFile]);
} else {
  fs.copyFileSync(video, outFile);
}
console.log('->', outFile);
process.exit(0);
