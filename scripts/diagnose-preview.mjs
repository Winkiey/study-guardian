/**
 * 诊断「课件预览为什么退化成了文字版」。
 *
 * 什么时候用：
 *   新上传的 PPT/Word/Excel 打开后只有文字、没有排版，
 *   而以前传的那些还能正常显示。这几乎总是「转 PDF 这一步失败了」——
 *   老课件不用重转（PDF 已经在 cache 里），所以看起来只有新的有问题。
 *
 * 用法（在服务器上）：
 *   cd /opt/study-guardian
 *   node scripts/diagnose-preview.mjs
 *
 * 想顺便重试一遍（比如上次是内存不够、超时这类临时原因）：
 *   node scripts/diagnose-preview.mjs --retry
 *
 * 它只读数据，不删任何东西；--retry 会重跑转换，不改你的其它数据。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import config from '../src/config.js';
import { all, get, getDb } from '../src/db/index.js';
import { converterStatus, converterReadiness } from '../src/lib/convert.js';
import { isConvertible } from '../src/lib/files.js';
import { listSlideImages, previewMode } from '../src/lib/materials.js';

const RETRY = process.argv.includes('--retry');

const line = (s = '') => console.log(s);
const rule = (title) => { line(); line(`── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`); };

/** 目录占用：文件数 + 总字节 */
function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        try { bytes += fs.statSync(p).size; } catch { /* 忽略 */ }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ============================================================
// 0. 这条进程自己
// ============================================================
line('学习守护 · 课件预览诊断');
line(`时间      ${new Date().toLocaleString('zh-CN')}`);
line(`Node      ${process.version}  (${process.platform} ${process.arch})`);
line(`数据目录  ${config.dataDir}`);
line(`时区      ${config.timezone}${process.env.TZ ? '（来自环境变量）' : ''}`);

// ============================================================
// 1. 磁盘与内存
//
// 转 PDF 要落一个和原件差不多大的产物，还要一份幻灯片图片；
// 内存不够时 LibreOffice 会被 OOM 杀掉，表现就是「转换失败」。
// 这两个是最常见的「用着用着就不行了」的原因，所以放在最前面看。
// ============================================================
rule('磁盘与内存');

try {
  // statfs 需要 Node 18.15+；拿不到就跳过，不让诊断本身报错
  const st = fs.statfsSync(config.dataDir);
  const total = st.blocks * st.bsize;
  const free = st.bavail * st.bsize;
  const usedPct = total ? ((1 - free / total) * 100).toFixed(1) : '?';
  line(`磁盘      ${mb(free)} 可用 / ${mb(total)} 共  （已用 ${usedPct}%）`);
  if (free < 512 * 1024 * 1024) {
    line('          ⚠️ 可用空间不足 512MB：转换很可能因为写不下而失败');
  }
} catch (err) {
  line(`磁盘      读不到（${err.message}）`);
}

const totalMem = os.totalmem();
const freeMem = os.freemem();
line(`内存      ${mb(freeMem)} 可用 / ${mb(totalMem)} 共`);
if (totalMem < 2.5 * 1024 * 1024 * 1024) {
  line('          小内存机器：LibreOffice 一次转换要几百 MB，');
  line('          如果同时有别的转换在跑，很容易被系统杀掉');
}

// ============================================================
// 2. 有没有卡住的转换进程
//
// 这条是「越用越坏」的典型症状来源：转换超时后如果只杀掉了外层脚本，
// 真正的 soffice.bin 会留在后台占着内存，越积越多，
// 直到新的一次转换必然失败。
// ============================================================
if (process.platform !== 'win32') {
  rule('残留的 LibreOffice 进程');
  let out = '';
  try {
    out = execSync('ps -eo pid,etimes,rss,args', { encoding: 'utf8', timeout: 10_000 });
  } catch {
    /* 没有 ps 就跳过 */
  }

  const rows = out.split('\n')
    .filter((l) => /soffice|oosplash|libreoffice/i.test(l) && !l.includes('diagnose-preview'))
    .map((l) => l.trim())
    .filter(Boolean);

  if (rows.length === 0) {
    line('没有残留进程 ✓');
  } else {
    let rssKb = 0;
    line(`发现 ${rows.length} 个（这是问题信号，下面逐条列出）：`);
    for (const r of rows) {
      const parts = r.split(/\s+/);
      const pid = parts[0];
      const etimes = Number(parts[1]);
      const rss = Number(parts[2]);
      if (Number.isFinite(rss)) rssKb += rss;
      line(`  pid=${pid}  已运行 ${Math.round(etimes / 60)} 分钟  占内存 ${mb(rss * 1024)}`);
      line(`    ${r.slice(0, 140)}`);
    }
    line(`  合计占用内存约 ${mb(rssKb * 1024)}`);
    line('  清理：pkill -f soffice');
  }
} else {
  rule('残留的 Office 进程');
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq POWERPNT.EXE"', { encoding: 'utf8', timeout: 10_000 });
    const n = (out.match(/POWERPNT\.EXE/g) || []).length;
    line(n ? `发现 ${n} 个残留的 POWERPNT.EXE 进程，建议：taskkill /IM POWERPNT.EXE /F` : '没有残留进程 ✓');
  } catch {
    line('读不到进程列表（跳过）');
  }
}

// ============================================================
// 3. 缓存目录的占用与残留
// ============================================================
rule('缓存目录');

for (const [label, dir] of [
  ['上传原件', config.uploadDir],
  ['转换出的 PDF', path.join(config.cacheDir, 'pdf')],
  ['幻灯片图片', path.join(config.cacheDir, 'slides')],
  ['缓存总计', config.cacheDir],
]) {
  const s = dirStats(dir);
  line(`${label.padEnd(12, ' ')} ${String(s.files).padStart(6)} 个文件  ${mb(s.bytes)}`);
}

try {
  const leftovers = fs.readdirSync(config.cacheDir)
    .filter((n) => n.startsWith('lo-profile-') || n.endsWith('.log'));
  if (leftovers.length) {
    line();
    line(`残留的临时文件 ${leftovers.length} 个（转换被中断时留下的，可以删）：`);
    for (const n of leftovers.slice(0, 8)) line(`  ${n}`);
    if (leftovers.length > 8) line(`  …还有 ${leftovers.length - 8} 个`);
    line(`  清理：rm -rf ${path.join(config.cacheDir, 'lo-profile-*')} ${path.join(config.cacheDir, '*.log')}`);
  } else {
    line('没有残留的临时文件 ✓');
  }
} catch { /* 忽略 */ }

// ============================================================
// 4. 转换器本身还能不能用
// ============================================================
rule('转换器状态');

const status = converterStatus();
line(`可用      ${status.available ? '是' : '否'}`);
line(`转换器    ${status.label}`);
line(`说明      ${status.message}`);

// converterReadiness() 返回的是 { available, reason }，没有现成的中文说明，
// 这里把 reason 翻一下 —— 排查时「not-installed」和「powershell-unavailable」
// 是两条完全不同的路，混在一起看会白折腾。
const REASON_CN = {
  ok: '正常',
  'not-installed': '系统里没找到任何转换器',
  'powershell-unavailable': '装了转换器，但 PowerShell 调不动 COM（Windows 上常见）',
};
try {
  const ready = converterReadiness();
  line(`就绪      ${ready.available ? '是' : '否'}  （${REASON_CN[ready.reason] || ready.reason}）`);
} catch (err) {
  line(`就绪      读不到（${err.message}）`);
}

if (!status.available) {
  // 「没装」和「装了但调不动」的修法不一样，别给错建议
  line();
  if (process.platform === 'win32') {
    line('修法：装一个免费的 LibreOffice（它不走 COM，能绕开 PowerShell 的问题）：');
    line('  https://www.libreoffice.org/');
  } else {
    line('修法（服务器上执行）：');
    line('  sudo apt update && sudo apt install -y libreoffice-impress libreoffice-writer libreoffice-calc');
    line('装完重启服务：pm2 restart study-guardian');
  }
}

// ============================================================
// 5. 最近上传的课件各自是什么状态
// ============================================================
rule('最近的课件');

getDb(); // 确保表结构就绪（顺带跑迁移）

const rows = all(
  `SELECT m.*, c.name AS course_name, u.username
     FROM materials m
     LEFT JOIN courses c ON c.id = m.course_id
     LEFT JOIN users u ON u.id = m.user_id
    ORDER BY m.id DESC LIMIT 15`,
);

if (!rows.length) {
  line('（还没有任何课件）');
}

const degraded = [];

for (const m of rows) {
  const mode = previewMode(m);
  let fileOk = false;
  try {
    fileOk = fs.statSync(path.join(config.uploadDir, m.stored_name)).size > 0;
  } catch { /* 文件不在 */ }

  const pdfOk = m.pdf_name
    ? (() => { try { return fs.statSync(path.join(config.uploadDir, m.pdf_name)).size > 0; } catch { return false; } })()
    : false;

  const slides = listSlideImages(m).length;

  const flags = [];
  flags.push(`status=${m.preview_status}`);
  flags.push(`渲染=${mode}`);
  // 「PDF 无」对 PDF 课件本身是正常的（它自己就是 PDF，不需要派生出一份），
  // 只有 Office 类型才该关心这一项 —— 不然会把人误导到错误的方向
  if (isConvertible(m.ext)) flags.push(`转换出的 PDF ${pdfOk ? '有' : '无'}`);
  if (slides) flags.push(`图片 ${slides} 张`);

  line();
  line(`#${m.id}  ${m.title}`);
  line(`    ${m.ext} · ${mb(m.size)} · 上传者 ${m.username || '?'} · ${m.created_at}`);
  line(`    ${flags.join(' · ')}${fileOk ? '' : '  ⚠️ 原件不在磁盘上！'}`);

  if (m.preview_status === 'failed' || mode === 'office' || m.preview_error) {
    line(`    原因：${String(m.preview_error || '').slice(0, 300) || '（没记录）'}`);
    if (mode === 'office' || m.preview_status === 'failed') degraded.push(m);
  }
}

// ============================================================
// 6. 可选：重试
// ============================================================
rule('小结');

if (degraded.length === 0) {
  line('最近的课件都渲染正常，没有需要重试的。');
} else {
  line(`有 ${degraded.length} 份课件没有渲染成 PDF/图片：${degraded.map((m) => `#${m.id}`).join(' ')}`);

  if (!RETRY) {
    line();
    line('如果上面「转换器状态」显示可用，而且没有残留进程，可以直接重试：');
    line('  node scripts/diagnose-preview.mjs --retry');
  } else {
    const { rebuildPreview } = await import('../src/lib/materials.js');
    line();
    line('开始重试（大文件可能要一两分钟，请耐心等）…');

    for (const m of degraded) {
      process.stdout.write(`  #${m.id} ${m.title} … `);
      try {
        const r = await rebuildPreview(m.user_id, m.id);
        const after = get('SELECT preview_status, preview_error, pdf_name FROM materials WHERE id = ?', m.id);
        const ok = Boolean(after?.pdf_name) || Boolean(r?.ok && after?.preview_status === 'ready');
        line(ok ? '好了 ✓' : `还是不行：${String(after?.preview_error || r?.error || '').slice(0, 160)}`);
      } catch (err) {
        line(`出错：${err.message}`);
      }
    }

    line();
    line('再跑一次不带参数的诊断，看结果：node scripts/diagnose-preview.mjs');
  }
}

line();
