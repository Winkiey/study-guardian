/**
 * Office → PDF 转换链路的测试。
 *
 * 起因是用户问：「能不能让课件直接渲染出来，有没有什么办法」。
 * 查下来真正的毛病是**我们自己的 spawn 参数**：
 * `stdio: 'ignore'` 配上 `windowsHide: true` 会让子进程以
 * 0xC0000142（STATUS_DLL_INIT_FAILED）挂掉，而单独用其中任何一个都正常。
 * 表现就是所有 Office 转换全军覆没，报错还长得像「Office 没装好」，
 * 极具误导性 —— 我第一次就被骗了，差点让用户去换个环境跑。
 *
 * 所以这里的重点是：
 *   1. 起子进程必须避开那个坏组合（下面有直接针对它的回归测试）
 *   2. PowerShell 探测要真的去启动进程，并且分得清各种失败原因
 *   3. converterStatus() 不在能力上对用户说大话
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-convert-test-'));

let convert;

before(async () => {
  convert = await import('../src/lib/convert.js');
});

after(() => {
  convert.resetConverterCache();
});

describe('★ 起子进程不能踩「ignore + windowsHide」的坑', () => {
  /**
   * 这个测试直接对着坑本身。
   *
   * 它不依赖我们的实现，而是先用最小复现把结论钉住：
   * 同一个 exe，只换 spawn 参数，结果一个能跑一个挂。
   * 哪天 Node 或系统行为变了、这个前提不成立，这里会先亮起来，
   * 免得我们守着一个过时的注释。
   */
  const ARGS = ['-e', 'process.exit(0)'];

  test('确认真空：stdio:ignore + windowsHide 确实会让子进程起不来', () => {
    const r = spawnSync(process.execPath, ARGS, { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    if (r.status === 0) {
      // 说明当前平台没有这个毛病，那下面的回归测试就没意义了，跳过即可
      return;
    }
    assert.equal(r.status >>> 0, 0xC0000142,
      `预期 0xC0000142，实际 ${r.status}`);
  });

  test('★ 换成文件描述符接输出之后就能正常起来', () => {
    const logPath = path.join(os.tmpdir(), `sg-spawn-${Date.now()}.log`);
    const fd = fs.openSync(logPath, 'a');
    try {
      const r = spawnSync(process.execPath, ARGS, {
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        timeout: 15_000,
      });
      assert.equal(r.status, 0,
        'stdio 用文件描述符时子进程应该能正常起来（这正是 spawnToLog 的做法）');
    } finally {
      fs.closeSync(fd);
      fs.rmSync(logPath, { force: true });
    }
  });
});

describe('PowerShell 探测', () => {
  test('★ 探测结果的结构是完整的', () => {
    const ps = convert.probePowershell();
    assert.equal(typeof ps.ok, 'boolean');
    assert.ok(
      ['ok', 'not-windows', 'not-found', 'failed'].includes(ps.status),
      `意外的 status：${ps.status}`,
    );
    assert.equal(typeof ps.message, 'string');
    assert.ok(ps.message.length > 0, '必须有一句能给人看的话');
  });

  test('★ 非 Windows 平台直接判定为不需要，不去启动进程', () => {
    if (process.platform === 'win32') return; // 只在非 Windows 上验证
    const ps = convert.probePowershell();
    assert.equal(ps.status, 'not-windows');
    assert.equal(ps.ok, true, '不需要 PowerShell 时不该拦住转换');
  });

  test('★ Windows 上探测结果应该和真实结论一致', () => {
    if (process.platform !== 'win32') return;
    const ps = convert.probePowershell();

    // 用和实现不同的方式独立验证一次：spawnSync + inherit
    const truth = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0'],
      { stdio: 'inherit', windowsHide: true, timeout: 20_000 },
    );

    if (truth.status === 0) {
      assert.equal(ps.ok, true,
        `PowerShell 明明能跑（独立验证退出码 0），探测却报了不可用：${ps.message}`);
    }
  });

  test('★ 探测失败时不能说成「环境不允许」这种推卸责任的话', () => {
    const ps = convert.probePowershell();
    if (ps.ok) return;
    assert.ok(!/被子进程被当前运行环境拦住|环境不允许/.test(ps.message),
      `把原因甩给环境了，而真正的原因很可能是我们自己的 spawn 参数：${ps.message}`);
  });

  test('探测结果是缓存的（不会每渲染一次页面就起一个进程）', () => {
    const a = convert.probePowershell();
    const b = convert.probePowershell();
    assert.equal(a, b, '应该是同一个对象');
  });

  test('resetConverterCache 会一并清掉探测缓存', () => {
    const before = convert.probePowershell();
    convert.resetConverterCache();
    const after = convert.probePowershell();
    assert.notEqual(before, after, '重置后应该重新探测');
  });
});

describe('converterReadiness 如实上报能力', () => {
  test('★ 返回结构包含「能不能真的用」和原因', () => {
    const r = convert.converterReadiness();
    assert.equal(typeof r.available, 'boolean');
    assert.ok(['ok', 'not-installed', 'powershell-unavailable'].includes(r.reason),
      `意外的 reason：${r.reason}`);
  });

  test('★ 没装任何转换器时说 not-installed', () => {
    const r = convert.converterReadiness();
    if (r.converter === null) {
      assert.equal(r.reason, 'not-installed');
      assert.equal(r.available, false);
    }
  });

  test('★ LibreOffice 路线不需要 PowerShell', () => {
    const r = convert.converterReadiness();
    if (r.converter?.type === 'libreoffice') {
      assert.equal(r.available, true);
      assert.equal(r.powershell, null, 'LibreOffice 是直接起进程，不该去探测 PowerShell');
    }
  });

  test('★ COM 路线只有在 PowerShell 真能跑时才算可用', () => {
    const r = convert.converterReadiness();
    if (r.converter && r.converter.type !== 'libreoffice') {
      const ps = convert.probePowershell();
      assert.equal(r.available, ps.ok,
        `PowerShell ok=${ps.ok}，但可用性报成了 ${r.available}`);
      if (!ps.ok) assert.equal(r.reason, 'powershell-unavailable');
    }
  });

  test('detectConverter 仍然只做静态探测（不做进程操作、可缓存）', () => {
    const a = convert.detectConverter();
    const b = convert.detectConverter();
    assert.equal(a, b);
  });
});

describe('converterStatus 不对用户说大话', () => {
  test('★ 调不动的时候绝不说「预览效果与原件一致」', () => {
    const status = convert.converterStatus();
    if (status.available) return;
    assert.ok(!/预览效果与原件一致/.test(status.message),
      `调不动却还承诺效果一致：${status.message}`);
  });

  test('★ 调不动时标签本身就要露馅，不能只写「可用」', () => {
    const status = convert.converterStatus();
    const ready = convert.converterReadiness();
    if (ready.reason !== 'powershell-unavailable') return;

    assert.equal(status.available, false);
    assert.equal(status.powershellUnavailable, true);
    assert.ok(!/可用/.test(status.label), `标签不能还说「可用」：${status.label}`);
    assert.match(status.label, /不可用/, '要一眼看出不行了');
    // 给用户的说明里只说「现在是什么效果」，不提 PowerShell / COM 这些内部机制
    assert.match(status.message, /文字版预览|没有排版/);
    assert.ok(!/PowerShell|COM\b/.test(status.message),
      `用户看不懂这些内部名词：${status.message}`);
    // 内部机制写在 adminHint 里，给站长看的
    assert.match(status.adminHint, /PowerShell/, 'adminHint 里要保留诊断信息');
  });

  test('★ 运维建议归 adminHint，不能出现在给用户的 message 里', () => {
    // 用户是拿手机看课件的同学，他改不了服务器。
    // 「装个免费的 LibreOffice」这类话写在 message 里，
    // 用户会以为自己得去做点什么，而其实什么都不用做。
    const status = convert.converterStatus();
    assert.ok(!/LibreOffice|apt install|重装|安装/.test(status.message),
      `message 里不该有安装/运维指引：${status.message}`);
    assert.equal(typeof status.adminHint, 'string', 'adminHint 字段要一直存在（可能是空串）');
  });

  test('★ 不能把「装个 Office / 重装 Office」当成解决办法', () => {
    const status = convert.converterStatus();
    if (status.powershellUnavailable !== true) return;

    // 注意：消息里不能出现「建议重装 Office」这类会让人白折腾的指引。
    // 这里只看有没有把它当建议提出来，不看是否提到这个词。
    assert.ok(!/(建议|请|可以|试试|不妨)[^。；]{0,12}(重新)?(安装|重装)[^。；]{0,6}Office/.test(status.message),
      `把重装 Office 当建议提了：${status.message}`);
    assert.ok(!/装个\s*(Microsoft\s*)?Office/.test(status.message),
      `把装 Office 当解决办法了：${status.message}`);
  });

  test('状态里有 label 和 message，设置页才有东西可显示', () => {
    const status = convert.converterStatus();
    assert.equal(typeof status.label, 'string');
    assert.equal(typeof status.message, 'string');
    assert.ok(status.label.length && status.message.length);
  });
});

describe('清理 Office 留下的临时文件', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-sweep-'));
  });

  test('★ 删掉陈旧的 msoXXXX.tmp', () => {
    const stale = path.join(dir, 'mso1234.tmp');
    const fresh = path.join(dir, 'mso5678.tmp');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    // 把 stale 的修改时间调到 20 分钟前
    const old = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const removed = convert.sweepOfficeTemp(dir);

    assert.equal(removed, 1, '应该只删掉陈旧的那个');
    assert.ok(!fs.existsSync(stale), '陈旧的要删掉');
    assert.ok(fs.existsSync(fresh), '太新的要留着 —— 可能还被 PowerPoint 占着');
  });

  test('★ 不碰其它文件（只认 mso*.tmp）', () => {
    const pdf = path.join(dir, '很重要的课.pdf');
    const other = path.join(dir, '其它的.tmp');
    fs.writeFileSync(pdf, 'x');
    fs.writeFileSync(other, 'x');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(pdf, old, old);
    fs.utimesSync(other, old, old);

    convert.sweepOfficeTemp(dir);

    assert.ok(fs.existsSync(pdf), 'PDF 不能被删 —— 那是正经产物');
    assert.ok(fs.existsSync(other), '不叫 mso 的 tmp 也不该动');
  });

  test('目录不存在时安静地返回 0，不抛异常', () => {
    assert.equal(convert.sweepOfficeTemp(path.join(dir, '不存在的目录')), 0);
  });
});

describe('convertToPdf 的前置检查', () => {
  test('★ 功能被关掉时明确说是配置问题', async () => {
    const config = (await import('../src/config.js')).default;
    const saved = config.enableOfficeConvert;
    config.enableOfficeConvert = false;
    try {
      const r = await convert.convertToPdf('whatever.pptx', '.pptx');
      assert.equal(r.ok, false);
      assert.match(r.error, /配置中关闭/);
    } finally {
      config.enableOfficeConvert = saved;
    }
  });

  test('★ 装了但调不动时，错误信息点明 PowerShell，而不是说「未检测到」', async () => {
    const ready = convert.converterReadiness();
    if (ready.reason !== 'powershell-unavailable') return;

    const r = await convert.convertToPdf('whatever.pptx', '.pptx');
    assert.equal(r.ok, false);
    assert.match(r.error, /PowerShell/, '要说清是 PowerShell 这一环');
    assert.ok(!/未检测到 LibreOffice/.test(r.error),
      '明明装了就别说没检测到，那样用户会去装第二个 Office');
    assert.match(r.error, /课件/, '要安抚一下：文件没丢');
  });
});

// ============================================================
// LibreOffice 的 PDF 导出过滤器
//
// 这一段来自真事：用户在云服务器上装好 LibreOffice 之后，PPT 能转 PDF 了，
// 但 Word / Excel 一直只能看文字版。原因是三者的导出过滤器**不是同一个**，
// 而代码里把演示文稿专用的 impress_pdf_Export 写死了。
//
// 这个坑在 Windows 上开发时完全看不出来 —— Windows 走 COM，不看这个参数。
// ============================================================

describe('★ LibreOffice 的 PDF 导出过滤器要按文档类型选', () => {
  test('★ 演示文稿用 Impress 的过滤器', () => {
    for (const ext of ['.ppt', '.pptx', '.pps', '.ppsx']) {
      assert.equal(convert.libreOfficePdfFilter(ext), 'impress_pdf_Export', `${ext} 的过滤器不对`);
    }
  });

  test('★ 文字文档用 Writer 的过滤器（写死 Impress 会让它永远转不出来）', () => {
    for (const ext of ['.doc', '.docx', '.rtf']) {
      assert.equal(convert.libreOfficePdfFilter(ext), 'writer_pdf_Export', `${ext} 的过滤器不对`);
    }
  });

  test('★ 表格用 Calc 的过滤器', () => {
    for (const ext of ['.xls', '.xlsx']) {
      assert.equal(convert.libreOfficePdfFilter(ext), 'calc_pdf_Export', `${ext} 的过滤器不对`);
    }
  });

  test('大小写都认；不认识的类型交给 LibreOffice 自己挑', () => {
    assert.equal(convert.libreOfficePdfFilter('.PPTX'), 'impress_pdf_Export');
    assert.equal(convert.libreOfficePdfFilter('.DocX'), 'writer_pdf_Export');
    assert.equal(convert.libreOfficePdfFilter('.odp'), 'pdf');
    assert.equal(convert.libreOfficePdfFilter(''), 'pdf');
    assert.equal(convert.libreOfficePdfFilter(null), 'pdf');
    assert.equal(convert.libreOfficePdfFilter(undefined), 'pdf');
  });

  test('★ 每一种「可转换」的类型都要有对应的过滤器，不能漏', async () => {
    // 这两个清单分在两个文件里，很容易加了一个忘了另一个。
    // 漏掉的后果是那种文件**永远**只能看文字版，而且不报错。
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/lib/files.js'),
      'utf8',
    );
    const m = /const CONVERTIBLE = new Set\(\[([^\]]+)\]\)/.exec(src);
    assert.ok(m, '应该能从 files.js 里读出 CONVERTIBLE 清单');

    const exts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.ok(exts.length >= 8, `应该读到足够多的类型，实际 ${exts.length}`);

    const missing = exts.filter((e) => convert.libreOfficePdfFilter(e) === 'pdf');
    assert.deepEqual(missing, [],
      `这些类型可转换，但没指定导出过滤器，会走到兜底值：${missing.join(', ')}`);
  });

  test('★ 静态守卫：过滤器不能再被写死成某一个', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/lib/convert.js'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    assert.ok(!/['"`]pdf:impress_pdf_Export['"`]/.test(src),
      '不要把过滤器写死成 impress_pdf_Export —— Word / Excel 用它会被 LibreOffice 拒绝');
    assert.match(src, /libreOfficePdfFilter\(ext\)/, '应该按扩展名取过滤器');
  });
});

// ============================================================
// 中文字体
//
// 这一段来自真事：用户在云服务器上装好 LibreOffice 之后，PPT 能转 PDF 了，
// 但**中文全是方框/乱码** —— 因为 PDF 是用服务器上装了的字体画字的，
// 而云服务器的精简镜像里一个中文字体都没有。
//
// 转换「成功」、不报任何错，只有人眼能看出来。所以必须主动查、主动报。
// ============================================================

describe('★ 中文字体的检测', () => {
  test('★ 解析 fc-list 的输出：一行一个字体，同族多语言名用逗号分隔', async () => {
    const { parseCjkFontFamilies } = await import('../src/lib/fonts.js');

    const got = parseCjkFontFamilies([
      'Noto Sans CJK SC',
      'WenQuanYi Micro Hei,WenQuanYi Micro Hei Mono,文泉驿微米黑',
      'AR PL UMing CN',
    ].join('\n'));

    assert.deepEqual(got, [
      'Noto Sans CJK SC',
      'WenQuanYi Micro Hei',
      'WenQuanYi Micro Hei Mono',
      '文泉驿微米黑',
      'AR PL UMing CN',
    ]);
  });

  test('重复的字体只留一份；空行、多余空格都清掉', async () => {
    const { parseCjkFontFamilies } = await import('../src/lib/fonts.js');
    assert.deepEqual(
      parseCjkFontFamilies('Noto Sans CJK SC\n\n  Noto Sans CJK SC  \n\t\n'),
      ['Noto Sans CJK SC'],
    );
  });

  test('没有输出就是没有（绝不能凭空说「有字体」）', async () => {
    const { parseCjkFontFamilies } = await import('../src/lib/fonts.js');
    for (const empty of ['', '\n', '\n\n', '   \n  ', null, undefined]) {
      assert.deepEqual(parseCjkFontFamilies(empty), [], `输入 ${JSON.stringify(empty)} 应该得到空数组`);
    }
  });

  test('★ 非 Linux 平台不去启动 fc-list（自带中文字体，也不该报警）', async () => {
    if (process.platform === 'linux') return; // 这条只在非 Linux 上验证
    const { cjkFontStatus, resetFontCache } = await import('../src/lib/fonts.js');
    resetFontCache();
    const s = cjkFontStatus();
    assert.equal(s.ok, true);
    assert.equal(s.skipped, true);
    assert.equal(s.reason, 'not-linux');
  });

  test('★ 结果会缓存（设置页每次渲染都调它，不能每次都起进程）', async () => {
    const { cjkFontStatus, resetFontCache } = await import('../src/lib/fonts.js');
    resetFontCache();
    const a = cjkFontStatus();
    const b = cjkFontStatus();
    assert.equal(a, b, '两次调用应该返回同一个对象');
  });

  test('★ 状态里带上了「缺中文字体」这个信息，页面才能提醒用户', () => {
    const s = convert.converterStatus();
    if (!s.available) return; // 没转换器时这一项无从谈起

    // 缺字体时要能查出来（字段存在且是布尔）
    assert.equal(typeof s.missingCjkFonts, 'boolean',
      'converterStatus() 应该给出 missingCjkFonts，供设置页显示警告');
    if (s.missingCjkFonts) {
      assert.match(s.message, /中文字体/, '缺字体时要在说明里讲清楚');
      assert.ok(!/apt install/.test(s.message),
        '装字体的命令不该出现在给用户看的说明里（那是站长的事）');
      assert.match(s.adminHint, /apt install/, '命令要保留在给站长看的 adminHint 里');
    }
  });
});
