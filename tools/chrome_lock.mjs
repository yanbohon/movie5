// 全局无头 Chrome 锁：16 GB 的机器上同一时间只允许一个截图 / 导出进程开 Chrome。
// 起因：7 个代理各开 Chrome + 本地 TTS 大模型，内存溢出死机。拿锁前还会看一眼系统空闲内存，太低就先等。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LOCK = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../out/.chrome.lock');

function freePercent() {
  try {
    const s = execFileSync('/usr/bin/memory_pressure', { encoding: 'utf8', timeout: 5000 });
    const m = s.match(/free percentage:\s*(\d+)%/);
    return m ? parseInt(m[1], 10) : 100;
  } catch { return 100; }
}

export async function acquireChromeLock({ label = '', timeoutMs = 45 * 60 * 1000, minFree = 22 } = {}) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  const t0 = Date.now();
  let said = false;
  for (;;) {
    let fd = null;
    try { fd = fs.openSync(LOCK, 'wx'); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd !== null) {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, label, t: new Date().toISOString() }));
      fs.closeSync(fd);
      const release = () => {
        try { const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(LOCK); } catch { /* 已经没了 */ }
      };
      process.on('exit', release);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(130); });
      // 拿到锁之后再看内存：别的非 Chrome 进程（音频渲染、大模型）占着的时候先等一会
      let waited = 0;
      for (let f = freePercent(); f < minFree && waited < 10 * 60; f = freePercent()) {
        if (waited === 0) console.log(`[chrome-lock] system memory free ${f}% < ${minFree}%, waiting ...`);
        await new Promise((r) => setTimeout(r, 5000));
        waited += 5;
      }
      return release;
    }
    // 锁在别人手里：持锁进程已经不在了（崩溃遗留）就清掉
    try {
      const st = fs.statSync(LOCK);
      let alive = true;
      try { const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8')); process.kill(cur.pid, 0); } catch (e) { alive = e.code === 'EPERM' || (Date.now() - st.mtimeMs < 5000); }
      if (!alive) { fs.unlinkSync(LOCK); continue; }
    } catch { continue; }
    if (!said) { console.log('[chrome-lock] another Chrome job is running, queued ...'); said = true; }
    if (Date.now() - t0 > timeoutMs) throw new Error('chrome lock timeout');
    await new Promise((r) => setTimeout(r, 800));
  }
}
