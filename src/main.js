// 入口：实时播放器 + 逐帧导出钩子（?capture=1）
import { Film, W, H, FPS } from './film/engine.js';
import { SCENES } from './scenes/index.js';
import timeline from '../script/timeline.json';

const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture');
const ONLY = params.get('scenes'); // 开发时只载入部分场景：?scenes=s0_cold,s1_2023
const START = parseFloat(params.get('t') || '0');
const DURATION = timeline.duration;

const canvas = document.getElementById('film');
const gate = document.getElementById('gate');
const film = new Film(canvas);

async function loadFonts() {
  const fams = ['FilmSans', 'FilmSerif', 'FilmKai', 'FilmMono'];
  await Promise.all(fams.flatMap((f) => [
    document.fonts.load(`400 40px ${f}`, '鲔白鲟长江宜宾'),
    document.fonts.load(`700 40px ${f}`, '鲔白鲟长江宜宾'),
  ]));
  await document.fonts.ready;
}

async function boot() {
  await loadFonts();
  const list = SCENES.filter((s) => !ONLY || ONLY.split(',').includes(s.id));
  const factories = [];
  for (const s of list) {
    const mod = await s.load();
    factories.push(mod.default);
  }
  const bar = gate.querySelector('.bar i');
  await film.load(factories, (k) => { bar.style.width = `${Math.round(k * 100)}%`; });
  return film;
}

// ---------- 导出模式：外部脚本逐帧调用 ----------
if (CAPTURE) {
  gate.style.display = 'none';
  document.getElementById('hud').style.display = 'none';
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  window.__film = {
    ready: boot().then(() => true),
    renderFrame(frame) {
      film.renderAt(frame / FPS);
      return true;
    },
    // 读回像素（RGBA，自下而上），交给导出脚本
    readPixels() {
      const gl = film.renderer.getContext();
      const buf = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    },
  };
} else {
  runPlayer();
}

// ---------- 实时播放器 ----------
async function runPlayer() {
  const hint = gate.querySelector('.hint');
  let audioBuf = null;
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const audioP = fetch('./audio/mix.m4a')
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('no audio'))))
    .then((b) => ac.decodeAudioData(b))
    .then((b) => { audioBuf = b; })
    .catch(() => { console.warn('没有找到配乐，静音播放'); });
  await Promise.all([boot(), audioP]);
  gate.classList.add('ready');
  hint.textContent = '点击开始 · 建议戴耳机';

  let src = null, t0 = 0, offset = START, playing = false;
  const clockNow = () => (playing ? ac.currentTime - t0 : offset);
  function play() {
    if (playing) return;
    ac.resume();
    if (audioBuf) {
      src = ac.createBufferSource();
      src.buffer = audioBuf;
      src.connect(ac.destination);
      src.start(0, Math.max(0, offset));
    }
    t0 = ac.currentTime - offset;
    playing = true;
    document.body.classList.remove('paused');
    pp.textContent = '暂停';
  }
  function pause() {
    if (!playing) return;
    offset = clockNow();
    if (src) { try { src.stop(); } catch (e) { /* 已停止 */ } src = null; }
    playing = false;
    document.body.classList.add('paused');
    pp.textContent = '播放';
  }
  function seek(t) {
    const was = playing;
    pause();
    offset = Math.max(0, Math.min(DURATION - 0.01, t));
    if (was) play();
  }

  const pp = document.getElementById('pp');
  const tc = document.getElementById('tc');
  const track = document.getElementById('track');
  pp.onclick = () => (playing ? pause() : play());
  track.onclick = (e) => { const r = track.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * DURATION); };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    if (e.code === 'ArrowRight') seek(clockNow() + 5);
    if (e.code === 'ArrowLeft') seek(clockNow() - 5);
    if (e.code === 'KeyF') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
  });
  gate.addEventListener('click', () => {
    gate.classList.add('hide');
    play();
  }, { once: true });

  function frame() {
    const t = clockNow();
    if (t >= DURATION) { pause(); offset = DURATION - 0.001; }
    film.renderAt(Math.min(t, DURATION - 0.001));
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    tc.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    track.firstElementChild.style.width = `${(t / DURATION) * 100}%`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
