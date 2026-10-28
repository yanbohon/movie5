// 收集各场景的画面事件（src/scenes/<id>/events.js，纯 JS、不依赖浏览器）→ audio/visual_events.json
// 音效按这些真实画面时刻对位。用法：node tools/collect_events.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tl = JSON.parse(fs.readFileSync(path.join(ROOT, 'script/timeline.json'), 'utf8'));
const out = [];
for (const s of tl.scenes) {
  const f = path.join(ROOT, 'src/scenes', s.id, 'events.js');
  if (!fs.existsSync(f)) continue;
  const mod = await import(pathToFileURL(f).href + `?v=${Date.now()}`);
  const evs = mod.events(tl);
  for (const e of evs) out.push({ scene: s.id, ...e, t: Math.round(e.t * 1000) / 1000 });
  console.log(`${s.id}: ${evs.length} events`);
}
out.sort((a, b) => a.t - b.t);
fs.mkdirSync(path.join(ROOT, 'audio'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'audio/visual_events.json'), JSON.stringify({ duration: tl.duration, events: out }, null, 1));
console.log(`-> audio/visual_events.json (${out.length} events)`);
