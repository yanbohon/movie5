// 场景注册表：按时间顺序。文件存在就自动载入（import.meta.glob），不用手动注册。
// 开发时可用 ?scenes=s1_river,s2_scroll 只载入一部分
const ORDER = ['s0_cold', 's1_river', 's2_scroll', 's3_2003', 's4_seven', 's5_sturgeon', 's6_yibin', 's7_end', 's8_epilogue'];
const mods = import.meta.glob('./s*_*.js');
export const SCENES = ORDER.filter((id) => mods[`./${id}.js`]).map((id) => ({ id, load: mods[`./${id}.js`] }));
