// 分段渲染整片：按场景边界切成若干段，每段单独调用 render.mjs 输出到 out/parts/，已存在且帧数正确的段跳过（可断点续渲）；
// 全部完成后无损拼接，再混入音轨，出母版（x264 CRF 16）和分享版（x265 CRF 22，hvc1）。
// 用法: node tools/render_parts.mjs [--workers 3] [--only 3,4] [--audio out/audio/mix.wav] [--master out/鲔_母版.mp4] [--share out/鲔.mp4]
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const TL = JSON.parse(fs.readFileSync(new URL('../script/timeline.json', import.meta.url)));
const FPS = TL.fps || 30;
const workers = opt('workers', '3');
const only = opt('only', '') ? opt('only', '').split(',').map(Number) : null;
const audio = opt('audio', 'out/audio/mix.wav');
const master = opt('master', 'out/鲔_母版.mp4');
const share = opt('share', 'out/鲔.mp4');
const partsDir = path.resolve('out/parts');
fs.mkdirSync(partsDir, { recursive: true });

// 段：按场景起点切（帧对齐），长场景再按 60 秒细分，单段出问题只重渲那一段
const total = Math.round(TL.duration * FPS);
const cuts = new Set([0, total]);
for (const s of TL.scenes) cuts.add(Math.round(s.start * FPS));
const sorted = [...cuts].filter((f) => f >= 0 && f <= total).sort((a, b) => a - b);
const segs = [];
for (let i = 0; i < sorted.length - 1; i++) {
  let a = sorted[i];
  const b = sorted[i + 1];
  while (b - a > 60 * FPS * 1.5) { segs.push([a, a + 60 * FPS]); a += 60 * FPS; }
  segs.push([a, b]);
}

const frameCount = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return parseInt(String(r.stdout).trim(), 10) || 0;
};

segs.forEach(([a, b], k) => {
  if (only && !only.includes(k)) return;
  const out = path.join(partsDir, `part_${String(k).padStart(2, '0')}_${a}_${b}.mp4`);
  if (fs.existsSync(out) && frameCount(out) === b - a) { console.log(`skip part ${k} (${a}-${b})`); return; }
  console.log(`\n== part ${k}: frames ${a}-${b} (${(a / FPS).toFixed(2)}s-${(b / FPS).toFixed(2)}s)`);
  execFileSync('node', ['tools/render.mjs', '--from', String(a / FPS), '--to', String(b / FPS), '--workers', workers, '--out', out], { stdio: 'inherit' });
  const n = frameCount(out);
  if (n !== b - a) throw new Error(`part ${k}: ${n} frames, expected ${b - a}`);
});

if (only) process.exit(0);
const files = segs.map(([a, b], k) => path.join(partsDir, `part_${String(k).padStart(2, '0')}_${a}_${b}.mp4`));
for (const f of files) if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
const list = path.join(partsDir, 'list.txt');
fs.writeFileSync(list, files.map((f) => `file '${f}'`).join('\n'));
const video = path.join(partsDir, 'video.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video], { stdio: 'inherit' });
console.log('video frames:', frameCount(video), 'expected', total);
const aArgs = fs.existsSync(audio) ? ['-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '256k'] : [];
// 分段编码时色彩标记没写进 SPS（ffprobe 显示 unknown），母版流拷贝时用码流过滤器补上 BT.709，不重编码
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, ...aArgs, '-c:v', 'copy',
  '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1',
  '-movflags', '+faststart', master], { stdio: 'inherit' });
console.log('master ->', master);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, ...aArgs,
  '-c:v', 'libx265', '-preset', 'slow', '-crf', '22', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p',
  '-x265-params', 'log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  '-movflags', '+faststart', share], { stdio: 'inherit' });
console.log('share ->', share);
