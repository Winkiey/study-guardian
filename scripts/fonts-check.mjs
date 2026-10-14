/**
 * 查「这份课件用的字体，这台服务器上有吗」。
 *
 * ## 它解决什么
 *
 * PPT 转 PDF 是**用服务器上装了的字体**去画字的。有两种后果，而且都不会报错：
 *
 *   · 找不到 Wingdings 那类符号字体 → 箭头、项目符号**变成方框**
 *     （那个字形没有任何字体提供，只能画个框）
 *   · 找不到 Calibri / 微软雅黑那类正文字体 → 换一个别的顶上，
 *     字宽不一样，于是**换行、对齐、溢出全跟着变**（"排版部分混乱"）
 *
 * 项目里原有的中文字体检查用的是 `fc-list :lang=zh` —— 那个过滤只列**覆盖中文**
 * 的字体，符号字体和西文字体它一个都看不到，所以这两种毛病它都发现不了。
 *
 * ## 用法
 *
 *   node scripts/fonts-check.mjs                      # 扫 data/uploads 下的全部课件
 *   node scripts/fonts-check.mjs 某份课件.pptx         # 只看一份
 *   node scripts/fonts-check.mjs --quiet              # 只打有问题的
 *
 * 退出码：0 = 没有问题（或者这台机器不需要查）；1 = 有课件引用了缺失的字体。
 * 这样它也能放进 cron / 上线检查里当一道闸。
 *
 * ⚠️ 部署目标是 Linux 服务器。在 Windows / macOS 上跑会提示「这台机器不用查」——
 *    那两台系统自带这些字体，本来就不会有这个毛病。
 */

import fs from 'node:fs';
import path from 'node:path';

import config from '../src/config.js';
import { fontCheckForBuffer, installHintFor, referencedFontsFromBuffer } from '../src/lib/fonts.js';

/** 只读引用、不下结论时用它（本机判不了的情况） */
const fontsReferenced = referencedFontsFromBuffer;

const args = process.argv.slice(2);
const quiet = args.includes('--quiet') || args.includes('-q');
const target = args.find((a) => !a.startsWith('-'));
const WITH_FONTS = new Set(['.pptx', '.docx', '.xlsx']);

/** 收集要查的文件 */
function collectFiles() {
  if (target) {
    const p = path.resolve(target);
    if (!fs.existsSync(p)) {
      console.error(`\n✗ 找不到文件：${p}\n`);
      process.exit(2);
    }
    return [p];
  }
  const dir = path.join(path.resolve(config.dataDir), 'uploads');
  if (!fs.existsSync(dir)) {
    console.error(`\n✗ 没有找到上传目录：${dir}`);
    console.error('  请在项目根目录下运行（或者用 DATA_DIR 指向真正的数据目录）。');
    console.error('  也可以直接点名一个文件：node scripts/fonts-check.mjs 某份课件.pptx\n');
    process.exit(2);
  }
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (WITH_FONTS.has(path.extname(ent.name).toLowerCase())) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const files = collectFiles();
if (!files.length) {
  console.log('\n没有找到 .pptx / .docx / .xlsx 课件。\n');
  process.exit(0);
}

/**
 * ⚠️ 只有 Linux 判得了「缺不缺」。
 *
 * 非 Linux 上 `fc-match` 根本没有（resolveFontFamilies 返回空数组），
 * 而"空数组"在 classifyFont 里代表**确实没有这个字体** ——
 * 于是每一个字体都会被报成"缺失"，还会打出一串安装命令。
 *
 * 第一版就是这样：开头写着「本机判不了，不判断缺不缺」，下面却列了
 * 4 种"缺失字体"并让人去 apt install。**输出自己打自己的脸**，
 * 而用户会照着去装一堆不需要的东西。
 * 所以这里把"判不了"和"查了但是没有"彻底分开：判不了就只列引用，不下结论。
 */
const canJudge = process.platform === 'linux';

if (!canJudge) {
  console.log('\n提示：这台机器不是 Linux（部署目标是 Linux 服务器）。');
  console.log('Windows / macOS 自带这些字体，本来就不会有这个问题。');
  console.log('所以下面**只列出课件引用了哪些字体**，不判断缺不缺 ——');
  console.log('请在服务器上跑这条命令，那里才有字库可以对比。\n');
}

/** 汇总：字体名 -> { 出现在哪些文件, 状态 } */
const problems = new Map();
let checked = 0;

for (const file of files) {
  let report;
  try {
    const buf = fs.readFileSync(file);
    report = canJudge
      ? fontCheckForBuffer(buf)
      // 判不了就只读引用，不去编一个"缺失"出来
      : { rows: [], referenced: fontsReferenced(buf), problems: [] };
  } catch (err) {
    // 读不出来的文件不算"没问题"，要单独说一声
    console.log(`  ?  ${path.basename(file)} —— 读不了（${err.message}）`);
    continue;
  }
  checked += 1;
  const rel = path.relative(process.cwd(), file);

  if (!quiet) {
    console.log(`\n${rel}`);
    if (canJudge) {
      for (const r of report.rows) {
        const mark = r.status === 'exact' ? '✓ 本机有'
          : r.status === 'metric' ? `≈ 用「${r.resolved}」替代（度量兼容，排版不变）`
            : r.status === 'substituted' ? `⚠ 被「${r.resolved}」顶替（排版会变）`
              : '✗ 这台机器上没有（会变方框）';
        console.log(`    ${r.status === 'exact' ? '✓' : ' '} ${r.requested}  ${mark}`);
      }
    } else {
      console.log(`    引用了：${report.referenced.join('、') || '（没读到字体信息）'}`);
    }
  }

  for (const r of report.problems) {
    if (!problems.has(r.requested)) {
      problems.set(r.requested, { status: r.status, resolved: r.resolved, files: [] });
    }
    problems.get(r.requested).files.push(rel);
  }
}

// 判不了的时候不该有结论，更不该给安装命令
if (!canJudge) {
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`读了 ${checked} 份课件的字体引用（本机不判断缺不缺，见上面的说明）。\n`);
  process.exit(0);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`查了 ${checked} 份课件`);
if (!problems.size) {
  console.log('\n✓ 没有发现缺失的字体。');
  if (process.platform !== 'linux') console.log('  （本机不是 Linux，所以这一条只说明"没读到问题"）');
  console.log('');
  process.exit(0);
}

console.log(`\n有 ${problems.size} 种字体在这台机器上不对：\n`);
const packages = new Set();
for (const [name, info] of problems) {
  const hint = installHintFor(name);
  console.log(`  ${name}`);
  console.log(`      情况：${info.status === 'missing' ? '这台机器上没有' : `被「${info.resolved}」顶替`}`);
  console.log(`      出现在：${info.files.slice(0, 3).join('、')}${info.files.length > 3 ? ` 等 ${info.files.length} 份` : ''}`);
  if (hint?.note) console.log(`      说明：${hint.note}`);
  for (const p of hint?.packages || []) packages.add(p);
}

if (packages.size) {
  console.log('\n装上这些（Ubuntu / Debian）：');
  console.log(`  sudo apt install -y ${[...packages].sort().join(' ')}`);
  console.log('\n装完要**重新转换**已有的课件才会生效：');
  console.log('  重新转换的按钮在每份课件的预览页上（右上角「重新转换」）。');
} else {
  console.log('\n这些字体没有免费的等价替代 —— 只能把字体本体放到服务器上（注意授权），');
  console.log('或者从课件里把它们换掉。');
}
console.log('');
process.exit(1);
