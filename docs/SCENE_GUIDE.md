# 《鲔》场景开发规范（每个做画面的人先读完）

《鲔》是一部 485 秒、全部由代码生成的 2D+3D 短片：2D 一律用 **p5.js**（p5.Graphics / 其 Canvas2D 上下文），3D 用 **three.js r186（WebGL2）**。
故事、分镜、时间已锁定。开工前按顺序读：
1. `script/shotlist.md`：逐镜头画面与声音（导演手册，最重要）
2. `script/timeline.json`：台词时间 `lines`、卡点 `marks`、场景边界 `scenes`、尾声字卡 `epilogue`
3. `script/lines.json`：台词原文与表演指示

配乐和音效正按 timeline 制作，画面必须卡在同样的时间点上。**任何时间一律从 timeline 读**（`ctx.mark('s2_scroll.dam_line')`、`ctx.line('L20').t`），不要写死秒数——配音或剪辑一改，写死的地方全会错位。

## 场景是什么
每个场景是 `src/scenes/<id>.js`，默认导出 async 工厂函数，拿到 `ctx`，建好资源，返回场景对象：

```js
export default async function (ctx) {
  const span = ctx.sceneSpan('s2_scroll');          // {start, end}
  // 一次性建资源：p5 画布、纸、纹理、材质……
  return {
    id: 's2_scroll', start: span.start, end: span.end,
    pre: 0, post: 0,                  // 可选：与相邻场景交叠的秒数（交叠时两个场景都渲染）
    enter(t) { return 0..1 },         // 可选：交叠时本场景的混合权重（默认交叉淡化）
    enterMode: 'dissolve',            // 可选：噪声溶解
    render(t, ctx) { ... },           // 画这一帧（t 是全片绝对时间）
    postFx(t) { return { ... } },     // 可选：本帧后期参数，见 src/film/post.js 的 DEFAULT_POST
    noSubtitles(t) { return false },  // 可选：true 时这一帧不画字幕
  };
}
```
`src/scenes/index.js` 已按 ORDER 自动发现，不用改。场景的辅助模块放 `src/scenes/<id>/` 子目录。

## 铁律
1. **一切都是时间 t 的纯函数。** 导出时多个浏览器各渲一段、会任意跳帧，同一个 t 必须永远得到同一帧。渲染时不许 Math.random、不许累积状态、不许依赖上一帧。随机只在建场景时用 `mulberry32(seed)`，或用 `hash1/hash2/hash3/noise1/noise2/fbm2`（src/film/util.js）。需要模拟（流体、墨扩散）的，要么在建场景时预先算好存下来，要么每帧从镜头起点确定性地重算。
2. **不许改别人的文件。** 共享模块 `src/film/*` 只读；需要改就在自己目录里包一层，并在报告里说明。`src/film/brush.js`（书法）归子代理 B，`src/film/ink.js`（水墨工具）归子代理 A，`src/film/fish.js / water.js / electro.js`（3D）归主导演。
3. **性能**：离线渲染，不追实时，但单帧 ≤ 400 ms（M4，1080p）。全屏 p5 画布每帧重画 + 上传纹理约 5–30 ms，一个场景同时更新的全屏 p5 画布 ≤ 3 张。重的东西（整幅长卷、纸）在建场景时画好缓存。建场景总耗时 ≤ 20 s。
4. **只用代码生成**：不下载任何图片、贴图、音频、模型。字体只有四个族：`ctx.FONTS.serif`（思源宋体）、`sans`（思源黑体）、`kai`（霞鹜文楷）、`mono`。画面里用到的新汉字跑 `.venv/bin/python tools/subset_fonts.py` 重新裁字体（它扫描 src/ 与 script/ 里所有字符）。大字书法用 `src/film/brush.js`（真实笔顺数据 hanzi-writer-data），不用字体。
5. 在自己的时间区间外不画任何东西。

## ctx 提供什么（src/film/engine.js 的 makeContext）
- `ctx.W, ctx.H`（1920×1080），`ctx.FPS`（30），`ctx.THREE`，`ctx.renderer`，`ctx.p`（p5 实例），`ctx.FONTS`，`ctx.timeline`
- `ctx.mark(id)`：卡点时间；`ctx.line(id)`：台词 `{t, dur, text, who}`；`ctx.lineProgress(id, t)`；`ctx.sceneSpan(id)`
- `ctx.draw(scene, camera)`：把 three 场景渲染到当前 HDR 目标（线性、HalfFloat、4x MSAA）
- `ctx.blit(material)`：全屏画一个 ShaderMaterial（顶点：`vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.,1.);`）
- `ctx.layer(w, h, {srgb, premult})`：新建 p5.Graphics + three 纹理，返回 `{g, ctx, tex}`；画完 `tex.needsUpdate = true`。当颜色图用：`srgb: true, premult: false`（采样出来就是线性色）
- `ctx.film.ov.ctx`：叠加层（Canvas2D，1920×1080 透明，不吃调色和泛光），适合字卡。字幕引擎自动画在下黑边里，不用管。
- `ctx.makeTarget(w, h)`、`ctx.under`（交叠时进入方可读退出方这一帧）

2D 场景的常规做法：p5 画到 `ctx.layer(...)`，用一个 ShaderMaterial 把纹理（可带镜头平移/缩放/纸纹叠加）`ctx.blit` 到 HDR 目标。
2D 场景的 `postFx` 请返回 `{ toneMix: 0, exposure: 1, bloom: 0–0.15, grain: 0.02–0.035, vignette: 0.2–0.35 }`，关掉 ACES，保证纸色不被压灰。

## 画幅
全片 2.39:1：可见画面是中间 1920×803（y 从 138 到 941），上下黑边由后期自动遮。构图只考虑中间这一条。字幕在下黑边里，画面里不要放东西去躲字幕。

## 美术规范
- 色板在 `src/film/paper.js` 的 `PALETTE`。纸：`makePaperCanvas / makePaperLayer`（全片同一种宣纸，带「吸墨度」fiber 图）。
- **2D 是水墨，不是矢量插画。** 标准：像真正的毛笔在宣纸上画的——浓淡干湿（浓墨、淡墨、焦墨、飞白）、湿边（墨迹边缘更深）、洇（墨沿纸纤维渗开，边缘毛）、叠墨、笔触有起笔收笔和按压变化、大量留白。禁止：均匀线宽的描边、纯色平涂、剪贴画感、渐变色块、描边+填充的卡通。人物是写意剪影（几笔），不画五官。
- 颜色纪律：2D 部分只有墨色和纸色。**朱砂红**全片只出现在三处：陨石（S2）、二十四针的红线（S3）、印章。**赭石**只在 S3 棉被。电感视觉的冷白青只属于 3D 与片名。
- 动起来的方式：笔触按时间「生长」（沿笔画路径显现，有速度变化）、墨在纸上慢慢洇开、淡墨层缓慢漂移、镜头平稳推拉摇移。不要弹跳、不要缓动过头的 UI 动效。
- 字：字卡用思源宋体（细、字距大）；纸上的小注用霞鹜文楷；大字书法用 brush.js。

## 画面事件（给音效对位用）
画面里有需要音效卡的具体动作（每一笔落下、每一针、每条鱼消失、墨炸开……），在 `src/scenes/<id>/events.js` 里导出纯函数（不许 import three / p5 / 浏览器 API）：
```js
export function events(tl) {   // tl = script/timeline.json 的内容
  const m = (id) => tl.marks.find((x) => x.id === id).t;
  return [{ t: m('s3_2003.stitch_end') - 2.1, id: 'stitch', kind: 'needle', i: 0 }, ...];
}
```
场景代码也从这个文件取同一批时刻，保证画面和声音用同一个数。`node tools/collect_events.mjs` 汇总到 `audio/visual_events.json`。

## 怎么看效果
开发服务器已在 `http://127.0.0.1:5174` 跑着（Vite，NO_HMR）。抽帧：
```
node tools/shot.mjs --scenes s2_scroll --times 95,104,113,131 --sheet s2_v1 --tag s2
```
在 `out/shots/s2_v1.png` 生成带时间码的联系表（用 Read 工具看图）；`--full` 另存原尺寸单帧；`--cols 2` 改列数。
**机器只有 16 GB 内存**：shot.mjs 自带全局 Chrome 锁，同一时间只有一个无头 Chrome，别绕开、别自己开浏览器。只载入自己的场景（`--scenes`）。跑重 Python 前看一眼 `memory_pressure | tail -1`，空闲低于 25% 先等。
浏览器里也能看：`http://127.0.0.1:5174/?scenes=s2_scroll&t=95`。

## 交付
场景文件 + 每 2–3 秒一帧的全场景联系表 + 关键时刻原尺寸单帧，并确认：控制台无报错；任意时间点单独渲染两次结果一致；区间外不画东西；建场景耗时和单帧耗时写进报告。
