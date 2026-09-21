/**
 * 从 全国大学表.xlsx 生成 src/data/schools.js。
 *
 * 为什么要有这个脚本、而不是手写一份数据文件：
 *   · 名单以后会更新（学校改名、新增），重新跑一遍就好，不用手工比对 3000 行；
 *   · xlsx 是**输入**（已 gitignore），进仓库的是生成出来的数据模块 ——
 *     这样仓库里那份是纯数据、没有多余列，也能被 diff 出来。
 *
 * 用法：node scripts/build-schools.js
 * 需要仓库根目录下有 全国大学表.xlsx（那是个本地文件，不入库）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractXlsx } from '../src/lib/office.js';

const root = path.resolve(import.meta.dirname, '..');
const SRC = path.join(root, '全国大学表.xlsx');
const OUT = path.join(root, 'src/data/schools.js');

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}\n这份 xlsx 是本地输入文件（.gitignore 里忽略了），需要先放到仓库根目录。`);
  process.exit(1);
}

const { sheets } = extractXlsx(fs.readFileSync(SRC));
const sheet = sheets.find((s) => s.rows.length > 1);
if (!sheet) {
  console.error('这个 xlsx 里没有可用的工作表');
  process.exit(1);
}

const header = sheet.rows[0].map((h) => String(h || '').trim());
const COL = {
  province: header.indexOf('省份'),
  city: header.indexOf('城市'),
  name: header.indexOf('院校名称'),
};
if (COL.name === -1) {
  console.error(`表头里找不到「院校名称」，实际表头：${JSON.stringify(header)}`);
  process.exit(1);
}

const seen = new Set();
const schools = [];
const skipped = [];

for (const row of sheet.rows.slice(1)) {
  const name = String(row[COL.name] ?? '').trim();
  // 空行和重复名都丢掉。重复名理论上不该有，真有的话留着会让「按名字反查」有歧义。
  if (!name) { skipped.push('（空行）'); continue; }
  if (seen.has(name)) { skipped.push(`重复：${name}`); continue; }
  seen.add(name);
  schools.push({
    name,
    province: COL.province === -1 ? '' : String(row[COL.province] ?? '').trim(),
    city: COL.city === -1 ? '' : String(row[COL.city] ?? '').trim(),
  });
}

schools.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

// ---- 生成模块 ----
// 数据写成**一个打包字符串**，而不是「一个名字数组 + 一个 Map 字面量」：
//   · 后者每所学校要占两行（一条名字、一条省份城市），3013 所就是 6000 行、
//     300KB，文件大到会让人不敢打开，diff 也全是噪音；
//   · 打包成一所学校一行，72KB，既小又能一眼看懂，diff 也只动真正变了的那几行。
// 格式：每行「校名\t省份\t城市」（缺的字段留空）。
const packed = schools
  .map((s) => [s.name, s.province, s.city].join('\t'))
  .join('\n');

const lines = [];
lines.push('/**');
lines.push(' * 全国高校名单（数据文件，别手改）。');
lines.push(' *');
lines.push(' * 由 scripts/build-schools.js 从「全国大学表.xlsx」生成。');
lines.push(' * 要更新名单：换掉根目录那个 xlsx，然后 `node scripts/build-schools.js`。');
lines.push(' *');
lines.push(' * ── 为什么需要一份固定名单 ──────────────────────────────────────');
lines.push(' * 1. 注册时手填学校，「家里蹲大学」也能过；而「同校」是校友社区**唯一**的');
lines.push(' *    可见性边界 —— 名字对不上，边界就等于没有。');
lines.push(' * 2. 从名单里选，同校判断才能靠**精确相等**，不用做模糊匹配。');
lines.push(' *    「北大」和「北京大学」算不算同校？模糊匹配永远答不清这种问题，');
lines.push(' *    而答不清就意味着有人能看到本不该看到的资料。');
lines.push(' */');
lines.push('');
lines.push('/**');
lines.push(' * 每行「校名\\t省份\\t城市」，按拼音序。');
lines.push(' * 用打包字符串而不是数组字面量，是为了让这个文件待在能读的大小里。');
lines.push(' */');
lines.push('const PACKED = `');
for (const s of schools) lines.push(`${s.name}\t${s.province}\t${s.city}`);
lines.push('`;');
lines.push('');
lines.push('const ROWS = PACKED.split(\'\\n\').filter(Boolean).map((line) => line.split(\'\\t\'));');
lines.push('');
lines.push('/**');
lines.push(' * 全部校名，按拼音序。前端自动补全只用这个数组。');
lines.push(' * @type {string[]}');
lines.push(' */');
lines.push('export const SCHOOL_NAMES = ROWS.map((r) => r[0]);');
lines.push('');
lines.push('export const SCHOOL_COUNT = SCHOOL_NAMES.length;');
lines.push('');
lines.push('const PLACES = new Map(ROWS.map((r) => [r[0], { province: r[1] || \'\', city: r[2] || \'\' }]));');
lines.push('');
lines.push('/** 这个名字在名单里吗（就是这一条挡住了手填的假学校） */');
lines.push('export function isKnownSchool(name) {');
lines.push('  return PLACES.has(String(name || \'\').trim());');
lines.push('}');
lines.push('');
lines.push('/** 学校在哪（「省份 城市」），查不到返回空串 */');
lines.push('export function schoolPlace(name) {');
lines.push('  const p = PLACES.get(String(name || \'\').trim());');
lines.push('  if (!p) return \'\';');
lines.push('  return [p.province, p.city].filter(Boolean).join(\' \');');
lines.push('}');
lines.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

console.log(`学校数：${schools.length}`);
console.log(`过滤掉：${skipped.length} 行${skipped.length ? `（${skipped.slice(0, 5).join('、')}）` : ''}`);
console.log(`有省份/城市的：${schools.filter((s) => s.province || s.city).length}`);
console.log(`重名（同名不同校）：${schools.length - new Set(schools.map((s) => s.name)).size}`);
console.log(`输出：${OUT}  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
console.log(`抽样：${schools.slice(0, 3).map((s) => `${s.name}(${s.province}${s.city})`).join('，')}`);
