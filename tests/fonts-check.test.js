/**
 * 「课件引用的字体，这台机器上有吗」。
 *
 * 要钉住的两件事：
 *
 * 1. **从 Office 文件里读字体名**。三种格式写法不一样（DrawingML / WordprocessingML /
 *    表格），而且**主题引用**（`+mn-lt`）必须跳过 —— 它不是字体名，
 *    照原样收进来会报出一串根本不存在的"缺失字体"。
 *
 * 2. **判断属于哪种情况**。这里最容易写错的是：
 *    `fc-match` **永远**会返回一个字体（找不到就兜底到默认字体），
 *    所以"有返回值"不等于"有这个字体"。必须把返回的名字和请求的名字比一遍，
 *    否则缺字体永远报成"正常"，而这正是箭头变方框的原因。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { buildZip } from './_zipfixture.js';

let fonts;

before(async () => {
  fonts = await import('../src/lib/fonts.js');
});

/** 造一个最小但结构真实的 pptx */
function makePptx({ typefaces = [], sym = null, themeFonts = ['Calibri Light', 'Calibri'] } = {}) {
  const runs = typefaces.map((t) => `<a:r><a:rPr><a:latin typeface="${t}"/></a:rPr><a:t>x</a:t></a:r>`).join('');
  const symXml = sym ? `<a:buFont type="none"/><a:sym typeface="${sym}"/>` : '';
  return buildZip([
    {
      name: 'ppt/slides/slide1.xml',
      data: Buffer.from(
        `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>`
        + `<p:sp><p:txBody><a:p>${runs}${symXml}</a:p></p:txBody></p:sp>`
        + `</p:spTree></p:cSld></p:sld>`, 'utf8',
      ),
    },
    {
      name: 'ppt/theme/theme1.xml',
      data: Buffer.from(
        `<a:theme><a:themeElements><a:fontScheme>`
        + themeFonts.map((f) => `<a:latin typeface="${f}"/>`).join('')
        + `</a:fontScheme></a:themeElements></a:theme>`, 'utf8',
      ),
    },
    { name: 'ppt/media/image1.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
}

describe('★ 从文件里读字体名', () => {
  test('★ pptx：正文用的字体认出来', () => {
    const buf = makePptx({ typefaces: ['微软雅黑', 'Calibri'] });
    const got = fonts.referencedFontsFromBuffer(buf);
    assert.ok(got.includes('微软雅黑'), `应该认出来：${got.join('、')}`);
    assert.ok(got.includes('Calibri'));
  });

  test('★★ 项目符号的符号字体（`a:sym`）也要认出来 —— 箭头方框就来自它', () => {
    const buf = makePptx({ sym: 'Wingdings' });
    const got = fonts.referencedFontsFromBuffer(buf);
    assert.ok(got.includes('Wingdings'),
      `★ 漏了 a:sym —— 这正好是"箭头变方框"那个字体：${got.join('、')}`);
  });

  test('★★ 主题引用（+mn-lt 之类）要跳过，不能当成缺失字体报出来', () => {
    const buf = buildZip([{
      name: 'ppt/slides/slide1.xml',
      data: Buffer.from(
        '<p:sld><p:sp><p:txBody><a:p><a:r><a:rPr>'
        + '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/>'
        + '</a:rPr><a:t>x</a:t></a:r></a:p></p:txBody></p:sp></p:sld>', 'utf8',
      ),
    }]);
    const got = fonts.referencedFontsFromBuffer(buf);
    assert.deepEqual(got, [], `★ 主题引用被当成了字体名：${got.join('、')}`);
  });

  test('★ 主题文件里的实际字体名会被读到（+mn-lt 的背后就是它）', () => {
    const buf = makePptx({ themeFonts: ['Calibri Light', 'Calibri'] });
    const got = fonts.referencedFontsFromBuffer(buf);
    assert.ok(got.includes('Calibri'), `主题里的字体名应该被读到：${got.join('、')}`);
  });

  test('★ docx 的写法（w:ascii / w:eastAsia）也认', () => {
    const buf = buildZip([{
      name: 'word/document.xml',
      data: Buffer.from(
        '<w:document><w:body><w:r><w:rPr>'
        + '<w:rFonts w:ascii="Calibri" w:eastAsia="宋体" w:hAnsi="Calibri"/>'
        + '</w:rPr><w:t>x</w:t></w:r></w:body></w:document>', 'utf8',
      ),
    }]);
    const got = fonts.referencedFontsFromBuffer(buf);
    assert.ok(got.includes('Calibri') && got.includes('宋体'), `实际：${got.join('、')}`);
  });

  test('★ xlsx 的 rFont 也认', () => {
    const buf = buildZip([{
      name: 'xl/styles.xml',
      data: Buffer.from('<styleSheet><fonts><font><name val="Arial"/><rFont val="等线"/></font></fonts></styleSheet>', 'utf8'),
    }]);
    const got = fonts.referencedFontsFromBuffer(buf);
    assert.ok(got.includes('等线'), `实际：${got.join('、')}`);
  });

  test('★ 名字去重，而且保持出现顺序', () => {
    const buf = makePptx({ typefaces: ['Calibri', 'Calibri', '宋体'] });
    const got = fonts.referencedFontsFromBuffer(buf).filter((n) => n === 'Calibri');
    assert.equal(got.length, 1, '同名应该只留一份');
  });

  test('不是 Office 文件时不抛异常，返回空', () => {
    const buf = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }]);
    assert.deepEqual(fonts.referencedFontsFromBuffer(buf), []);
  });
});

describe('★★ 判断属于哪种情况', () => {
  test('★ 精确命中：fontconfig 给出的就是同名字体', () => {
    const r = fonts.classifyFont('Noto Sans CJK SC', ['Noto Sans CJK SC']);
    assert.equal(r.status, 'exact');
  });

  test('★ 度量兼容替代算「没问题」（排版不会变）', () => {
    // 装了 fonts-liberation 之后，Arial 会被 Liberation Sans 顶上 —— 这是**好事**
    for (const [req, resolved] of [
      ['Arial', 'Liberation Sans'],
      ['Times New Roman', 'Liberation Serif'],
      ['Courier New', 'Liberation Mono'],
      ['Calibri', 'Carlito'],
      ['Cambria', 'Caladea'],
    ]) {
      const r = fonts.classifyFont(req, [resolved]);
      assert.equal(r.status, 'metric', `${req} → ${resolved} 应该判成度量兼容`);
    }
  });

  test('★★ 被别的字体顶替 → substituted（排版会变，不能报成"正常"）', () => {
    const r = fonts.classifyFont('微软雅黑', ['WenQuanYi Micro Hei']);
    assert.equal(r.status, 'substituted',
      '★ 微软雅黑被顶替了却报成正常 —— 这正对应"排版部分混乱"');
    assert.equal(r.resolved, 'WenQuanYi Micro Hei');
  });

  test('★★ 一个替代都没有 → missing（会变方框）', () => {
    const r = fonts.classifyFont('Wingdings', []);
    assert.equal(r.status, 'missing',
      '★ 符号字体没有替代却报成正常 —— 这正对应"箭头变方框"');
  });

  test('★★ fc-match 永远有返回值，所以"有返回"不等于"有这个字体"', () => {
    // 这就是最容易写错的地方：只看 fc-match 有没有输出的话，
    // 上面那两条都会变成"正常"，而用户看到的方框和错位一个都解释不了。
    const missing = fonts.classifyFont('Wingdings', ['DejaVu Sans']);
    assert.notEqual(missing.status, 'exact');
    assert.equal(missing.status, 'substituted', '兜底到默认字体也算被顶替，不能算命中');
  });

  test('大小写不同也算命中（字体名不该区分大小写）', () => {
    assert.equal(fonts.classifyFont('calibri', ['Calibri']).status, 'exact');
  });

  test('空名字、坏输入不抛异常', () => {
    assert.doesNotThrow(() => fonts.classifyFont('', []));
    assert.doesNotThrow(() => fonts.classifyFont(null, null));
    assert.doesNotThrow(() => fonts.classifyFont('X', [null, undefined, '']));
  });
});

describe('★ 整体报告 + 安装建议', () => {
  test('★ fontCheckForBuffer 用注入的 resolve，把问题挑出来', () => {
    const buf = makePptx({ typefaces: ['Calibri', '微软雅黑'], sym: 'Wingdings' });
    // 模拟一台"只有中文字体、西文和符号都没有"的服务器
    const resolve = (name) => {
      if (/^calibri/i.test(name)) return ['Carlito'];
      if (name === '微软雅黑') return ['WenQuanYi Micro Hei'];
      if (name === 'Wingdings') return [];
      return [];
    };
    const report = fonts.fontCheckForBuffer(buf, { resolve });
    const names = report.problems.map((p) => p.requested).sort();
    assert.ok(names.includes('微软雅黑'), `应该报出来：${names.join('、')}`);
    assert.ok(names.includes('Wingdings'), `符号字体应该报出来：${names.join('、')}`);
    assert.ok(!names.includes('Calibri'),
      '★ Carlito 是度量兼容替代，不该报成问题（报了就是狼来了）');
  });

  test('★ 建议：度量兼容的那几个要指向对应的包', () => {
    assert.equal(fonts.installHintFor('Calibri').packages[0], 'fonts-crosextra-carlito');
    assert.equal(fonts.installHintFor('Arial').packages[0], 'fonts-liberation');
  });

  test('★★ 符号字体的建议必须说实话：没有免费的等价替代', () => {
    const h = fonts.installHintFor('Wingdings');
    assert.deepEqual(h.packages, [],
      '★ 给 Wingdings 编一个 apt 包名的话，用户会去装一个不存在的包');
    assert.ok(/没有免费/.test(h.note), `建议里要说清这一点：${h.note}`);
    assert.ok(/方框/.test(h.note), '要说清不处理的后果是什么');
  });

  test('认不出来的字体也有兜底建议（不能返回 null）', () => {
    assert.ok(fonts.installHintFor('某个没见过的手写体'));
  });
});

describe('★★ 命令行脚本：判不了的时候不能下结论', () => {
  test('★★ 本机不是 Linux 时，只说"引用了什么"，不说"缺什么"', async () => {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-fonts-cli-'));
    const file = path.join(dir, '课件.pptx');
    fs.writeFileSync(file, makePptx({ typefaces: ['微软雅黑'], sym: 'Wingdings' }));

    const logPath = path.join(dir, 'out.txt');
    const fd = fs.openSync(logPath, 'w');
    const res = spawnSync(process.execPath, ['scripts/fonts-check.mjs', file], {
      cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', fd, fd],
    });
    fs.closeSync(fd);
    const out = fs.readFileSync(logPath, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });

    // 引用一定能读出来（这一步和平台无关）
    assert.ok(/微软雅黑/.test(out) && /Wingdings/.test(out),
      `应该列出引用的字体：\n${out}`);

    if (process.platform === 'linux') {
      // Linux 上才该下结论
      assert.ok(/有 \d+ 种字体在这台机器上不对/.test(out) || /✓ 没有发现缺失的字体/.test(out),
        `Linux 上应该给出结论：\n${out}`);
    } else {
      // ★ 非 Linux 上 fc-match 不存在，"每个字体都查不到"会被误报成"全都缺"。
      //   第一版就是这样：开头写着"不判断缺不缺"，下面却列了 4 种缺失字体
      //   还打出一串 apt install —— 输出自己打自己的脸。
      assert.ok(!/种字体在这台机器上不对/.test(out),
        `★ 本机判不了却下了"缺失"的结论：\n${out}`);
      assert.ok(!/apt install/.test(out), `★ 判不了还给了安装命令：\n${out}`);
      assert.equal(res.status, 0, '判不了的时候不该以失败退出（那会误报成"有问题"）');
    }
  });
});
