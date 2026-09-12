#!/usr/bin/env node
/**
 * 环境自检。
 *
 * 装不起来 / 用着不对劲的时候先跑这个：
 *   npm run doctor      或      node scripts/doctor.js
 *
 * 它只做检查，不改任何东西。每一项都会告诉你「结论」和「怎么办」。
 */

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];

/** 配置对象，各检查项共用。加载失败时保持 null。 */
let config = null;

function check(name, status, detail, advice = '') {
  results.push({ name, status, detail, advice });
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

const OK = '\u001b[32m✓\u001b[0m';
const WARN = '\u001b[33m!\u001b[0m';
const BAD = '\u001b[31m✗\u001b[0m';

const MARK = { ok: OK, warn: WARN, bad: BAD };

// ============================================================
// 1. Node.js 版本与内置能力
// ============================================================

async function checkNode() {
  section('1. Node.js 运行环境');

  const [major, minor] = process.versions.node.split('.').map(Number);

  if (major > 22 || (major === 22 && minor >= 5)) {
    check('Node.js 版本', 'ok', `v${process.versions.node}`);
  } else {
    check(
      'Node.js 版本',
      'bad',
      `v${process.versions.node}（需要 v22.5.0 或更高）`,
      '到 https://nodejs.org 下载 LTS 版本安装。本平台用 Node 内置的 node:sqlite，'
      + '所以对版本有硬性要求。',
    );
  }

  // node:sqlite 是核心依赖
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(a INTEGER)');
    db.prepare('INSERT INTO t VALUES (?)').run(42);
    const row = db.prepare('SELECT a FROM t').get();
    db.close();
    if (row.a === 42) {
      check('内置 SQLite (node:sqlite)', 'ok', '可用');
    } else {
      check('内置 SQLite (node:sqlite)', 'bad', '查询结果异常');
    }
  } catch (err) {
    check(
      '内置 SQLite (node:sqlite)',
      'bad',
      err.message,
      '说明 Node 版本过旧或被裁剪过。装官方版 Node.js 即可解决。',
    );
  }

  // ICU：决定 GBK 编码的课表文件能不能读
  try {
    new TextDecoder('gb18030');
    check('GBK/GB18030 解码支持', 'ok', '可用（教务系统导出的 GBK 文件能正常读）');
  } catch {
    check(
      'GBK/GB18030 解码支持',
      'warn',
      '不可用',
      '教务处导出的 CSV 可能是 GBK 编码，会遇到乱码。建议安装完整版 Node.js（带 full-icu）。',
    );
  }

  // node:test：跑测试用
  try {
    await import('node:test');
    check('内置测试运行器 (node:test)', 'ok', '可用（npm test 能跑）');
  } catch {
    check('内置测试运行器 (node:test)', 'warn', '不可用', '不影响正常使用，只是跑不了单元测试。');
  }
}

// ============================================================
// 2. 目录与权限
// ============================================================

async function checkStorage() {
  section('2. 数据目录与读写权限');

  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(ROOT, 'data');

  console.log(`    数据目录：${dataDir}`);

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    check('创建数据目录', 'ok', dataDir);
  } catch (err) {
    check('创建数据目录', 'bad', err.message, '检查一下目录权限，或者用 DATA_DIR 环境变量换个位置。');
    return;
  }

  // 实际写一个文件试试，比看权限位可靠
  const probe = path.join(dataDir, `.doctor-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.readFileSync(probe, 'utf8');
    fs.unlinkSync(probe);
    check('读写测试', 'ok', '可以正常读写');
  } catch (err) {
    check('读写测试', 'bad', err.message, '数据目录不可写，服务无法保存数据。');
  }

  // 磁盘剩余空间
  try {
    const stats = fs.statfsSync(dataDir);
    const freeGB = (stats.bavail * stats.bsize) / 1024 / 1024 / 1024;
    if (freeGB > 2) {
      check('磁盘剩余空间', 'ok', `${freeGB.toFixed(1)} GB`);
    } else {
      check('磁盘剩余空间', 'warn', `${freeGB.toFixed(2)} GB`, '空间不多了，课件多了可能存不下。');
    }
  } catch {
    check('磁盘剩余空间', 'warn', '无法获取');
  }

  // 数据库文件
  const dbFile = path.join(dataDir, 'app.db');
  if (fs.existsSync(dbFile)) {
    const size = ['app.db', 'app.db-wal'].reduce((sum, f) => {
      try {
        return sum + fs.statSync(path.join(dataDir, f)).size;
      } catch {
        return sum;
      }
    }, 0);
    check('数据库文件', 'ok', `已存在，约 ${(size / 1024).toFixed(0)} KB`);
  } else {
    check('数据库文件', 'warn', '还没创建', '首次启动服务时会自动建好，这是正常的。');
  }

  // 上传目录
  const uploadDir = path.join(dataDir, 'uploads');
  let fileCount = 0;
  let totalBytes = 0;
  if (fs.existsSync(uploadDir)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else {
          fileCount += 1;
          totalBytes += fs.statSync(p).size;
        }
      }
    };
    walk(uploadDir);
    check('课件存储', 'ok', `${fileCount} 个文件，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  } else {
    check('课件存储', 'warn', '还没创建', '上传第一个课件时会自动建好。');
  }
}

// ============================================================
// 3. 端口
// ============================================================

function checkPort(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve({ free: false, reason: '端口已被占用' });
      } else {
        resolve({ free: false, reason: err.message });
      }
    });

    server.once('listening', () => {
      server.close(() => resolve({ free: true }));
    });

    server.listen(port, host);
  });
}

async function checkNetwork() {
  section('3. 网络与端口');

  try {
    const mod = await import('../src/config.js');
    config = mod.default;
  } catch (err) {
    check('加载配置', 'bad', err.message, '配置文件有语法错误，请检查 .env。');
    return;
  }

  console.log(`    监听地址：${config.host}:${config.port}`);

  const result = await checkPort(config.port, config.host);
  if (result.free) {
    check(`端口 ${config.port}`, 'ok', '可用');
  } else {
    check(
      `端口 ${config.port}`,
      'warn',
      result.reason,
      '可能本平台已经在运行了，先访问一下看看。要换端口就改 .env 里的 PORT。',
    );
  }

  if (config.host === '127.0.0.1') {
    check(
      '监听范围',
      'ok',
      '仅本机可访问（最安全）',
    );
    console.log('      · 想让手机也能打开，把 .env 里的 HOST 改成 0.0.0.0');
  } else if (config.host === '0.0.0.0') {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
      }
    }
    check('监听范围', 'warn', '局域网内所有设备都能访问');
    console.log(`      · 手机可访问：${ips.map((ip) => `http://${ip}:${config.port}`).join('  ') || '（未检测到局域网 IP）'}`);
    console.log('      · 注意：同一 Wi-Fi 下的其他人也能打开这个地址');
  }

  // 时区
  const offsetMin = -new Date().getTimezoneOffset();
  const offsetStr = `UTC${offsetMin >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMin) % 60).padStart(2, '0')}`;
  if (offsetMin === 480) {
    check('系统时区', 'ok', `${offsetStr}（东八区，符合预期）`);
  } else {
    check(
      '系统时区',
      'warn',
      `${offsetStr}，不是东八区`,
      '课表和作业 DDL 都按系统本地时间计算。如果人在国内，建议把系统时区设成「北京时间」，'
      + '否则提醒时间会整体偏移。',
    );
  }
}

// ============================================================
// 4. Office 文件预览能力
// ============================================================

async function checkOffice() {
  section('4. PPT / Word 在线预览能力');

  let convert = null;
  try {
    convert = await import('../src/lib/convert.js');
  } catch (err) {
    check('加载转换模块', 'bad', err.message);
    return;
  }

  const ready = convert.converterReadiness();
  const status = convert.converterStatus();

  if (ready.available) {
    check('Office 转换器', 'ok', status.label);
    if (ready.converter.type === 'libreoffice') {
      console.log('      · PPT / Word / Excel 会先转成 PDF，预览效果与原件一致');
    } else {
      // COM 路线额外确认 PowerShell 真的跑得起来。
      // 注意：这里刻意不用管道收输出 ——
      // 受限环境常常不允许创建管道，用管道探测会把「环境受限」误报成「探测失败」。
      const ps = convert.probePowershell();
      check('PowerShell 可用', ps.ok ? 'ok' : 'warn', ps.message);
      console.log('      · PPT / Word / Excel 会先转成 PDF，预览效果与原件一致');
    }
  } else if (ready.reason === 'powershell-unavailable') {
    // 以前这种情况会走到上面的 available 分支，报「可用，效果与原件一致」，
    // 但实际所有转换都注定失败，把用户坑得很惨。现在如实报出来。
    check('Office 转换器', 'bad', `${ready.converter.label}（调不动）`);
    console.log(`      · ${ready.powershell.message}`);
    console.log('      · 课件内容不会丢，目前显示的是内置解析器抽出来的文字版预览（没有排版）');
    console.log('      · 装个免费的 LibreOffice 可以绕开 PowerShell：https://www.libreoffice.org/');
  } else {
    check('Office 转换器', 'warn', '未检测到');
    console.log('      · PPT / Word 会用内置解析器渲染成网页版预览（只有文字和结构，没有排版）');
    console.log('      · 想要和原件一致的预览效果，二选一：');
    console.log('        1) 装 Microsoft Office 或 WPS（你已经装的会自动被探测到）');
    console.log('        2) 装免费的 LibreOffice：https://www.libreoffice.org/');
  }

  if (config && !config.enableOfficeConvert) {
    check('自动转换开关', 'warn', '已在配置中关闭', '把 .env 里的 ENABLE_OFFICE_CONVERT 改成 true 可以打开。');
  }
}

// ============================================================
// 5. 通知能力
// ============================================================

async function checkNotify() {
  section('5. 手机提醒能力');

  let notify = null;
  try {
    notify = await import('../src/lib/notify/channels.js');
  } catch (err) {
    check('加载通知模块', 'bad', err.message);
    return;
  }

  const channels = notify.channelCatalog();
  check('内置推送渠道', 'ok', `${channels.length} 种：${channels.map((c) => c.label).join('、')}`);

  // 数据库里的渠道配置
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
  if (!fs.existsSync(path.join(dataDir, 'app.db'))) {
    check('已配置的渠道', 'warn', '数据库还没创建', '首次启动并登录后再回来跑这个检查。');
    return;
  }

  try {
    const { getDb } = await import('../src/db/index.js');
    getDb();
    const { all } = await import('../src/db/index.js');
    const rows = all('SELECT type, name, enabled FROM notify_channels');

    if (rows.length === 0) {
      check(
        '已配置的渠道',
        'warn',
        '还没有配置任何渠道',
        '推荐 iPhone 用户用 Bark：App Store 搜 Bark 装上，把首页那串 Key 填进「设置 → 手机提醒」。',
      );
    } else {
      const enabled = rows.filter((r) => Number(r.enabled) === 1);
      check('已配置的渠道', enabled.length ? 'ok' : 'warn',
        `${rows.length} 个（启用 ${enabled.length} 个）：${rows.map((r) => r.name || r.type).join('、')}`);
    }

    // 最近发送记录
    const logs = all('SELECT ok, created_at FROM notify_log ORDER BY id DESC LIMIT 20');
    if (logs.length) {
      const okCount = logs.filter((l) => Number(l.ok) === 1).length;
      check('最近发送记录', okCount === logs.length ? 'ok' : 'warn',
        `最近 ${logs.length} 条，成功 ${okCount} 条`);
      if (okCount < logs.length) {
        console.log('      · 有失败记录，去「设置 → 提醒调度 → 发送记录」看具体错误');
      }
    }
  } catch (err) {
    check('读取渠道配置', 'warn', err.message);
  }
}

// ============================================================
// 6. 代码完整性
// ============================================================

async function checkIntegrity() {
  section('6. 代码与数据完整性');

  const required = [
    'server.js',
    'package.json',
    'src/config.js',
    'src/db/schema.js',
    'src/lib/ics.js',
    'src/lib/zip.js',
    'src/lib/office.js',
    'src/lib/smtp.js',
    'src/web/public/app.css',
    'src/web/public/app.js',
  ];

  const missing = required.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length === 0) {
    check('核心文件齐备', 'ok', `${required.length} 个文件都在`);
  } else {
    check('核心文件齐备', 'bad', `缺少：${missing.join('、')}`, '文件不完整，建议重新下载或 git clone。');
  }

  // 图标（PWA 需要）
  const icons = ['icon-192.png', 'icon-512.png', 'favicon.svg'];
  const missingIcons = icons.filter((f) => !fs.existsSync(path.join(ROOT, 'src/web/public', f)));
  if (missingIcons.length === 0) {
    check('PWA 图标', 'ok', '都生成了');
  } else {
    check('PWA 图标', 'warn', `缺少：${missingIcons.join('、')}`,
      '跑一下 node scripts/make-icons.js 可以重新生成。');
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('\n\u001b[1m学习守护平台 · 环境自检\u001b[0m');
  console.log(`项目目录：${ROOT}`);
  console.log(`系统：${os.type()} ${os.release()} / ${os.arch()}`);

  await checkNode();
  await checkStorage();
  await checkNetwork();
  await checkOffice();
  await checkNotify();
  await checkIntegrity();

  // 汇总
  const bad = results.filter((r) => r.status === 'bad');
  const warn = results.filter((r) => r.status === 'warn');
  const good = results.filter((r) => r.status === 'ok');

  console.log(`\n${'─'.repeat(60)}`);
  console.log('\u001b[1m自检结果\u001b[0m\n');

  for (const r of results) {
    console.log(`${MARK[r.status]} ${r.name.padEnd(24)} ${r.detail}`);
    if (r.advice && r.status !== 'ok') {
      console.log(`    \u001b[2m→ ${r.advice}\u001b[0m`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`通过 ${good.length} 项 · 提醒 ${warn.length} 项 · 异常 ${bad.length} 项`);

  if (bad.length === 0 && warn.length === 0) {
    console.log('\n\u001b[32m\u001b[1m一切正常，直接 npm start 就能用了。\u001b[0m\n');
  } else if (bad.length === 0) {
    console.log('\n\u001b[33m可以用，但有几项建议处理一下（见上面的 → ）。\u001b[0m\n');
  } else {
    console.log('\n\u001b[31m\u001b[1m有必须先解决的问题（见上面的 ✗ 和 → ）。\u001b[0m\n');
  }

  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n自检脚本本身出错了：', err);
  process.exit(1);
});
