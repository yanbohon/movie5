// 从 hanzi-writer-data（Make Me a Hanzi 的楷书轮廓 + 笔顺中线）里抽出剧本要用的字 → src/data/hanzi.json
// 前端只 import 这个小文件，免得 Vite 去扫 9000 多个 json。
// 用法：node tools/extract_hanzi.mjs   （字表在 script/brush_chars.txt，一行若干字，# 开头是注释）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'node_modules/hanzi-writer-data');
const LIST = path.join(ROOT, 'script/brush_chars.txt');
const OUT = path.join(ROOT, 'src/data/hanzi.json');

const chars = [];
for (const line of fs.readFileSync(LIST, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s || s.startsWith('#')) continue;
  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    if (!chars.includes(ch)) chars.push(ch);
  }
}

const out = {};
const missing = [];
for (const ch of chars) {
  const f = path.join(SRC, `${ch}.json`);
  if (!fs.existsSync(f)) { missing.push(ch); continue; }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  // 只留轮廓与中线（1024 字框，y 轴向上，基线偏移 900：屏幕 y = 900 - y）
  out[ch] = { strokes: d.strokes, medians: d.medians };
}
if (missing.length) {
  console.error(`hanzi-writer-data 里没有这些字：${missing.join('')}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const n = Object.values(out).reduce((a, g) => a + g.strokes.length, 0);
console.log(`${chars.length} 字 / ${n} 笔 -> ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
console.log(chars.map((c) => `${c}${out[c].strokes.length}`).join(' '));
