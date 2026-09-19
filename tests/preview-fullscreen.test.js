/**
 * 课件的「全屏观看」。
 *
 * 需求：资料预览页要能全屏看课件。原来只有「幻灯片图片」那条路有个覆盖全屏的
 * 看图器，而 **PDF 模式（服务器上最主要的模式）只是一个 <iframe>，没有任何全屏入口**，
 * 文字版和网页版 Office 也没有。
 *
 * 实现上只有一件事：给 .preview-main 加 is-immersive 类让它铺满视口。
 * 之所以用 CSS 而不是只依赖 Fullscreen API：iPhone 上的 Safari 不允许对普通元素
 * 调用 requestFullscreen，只靠它手机上点了没反应。
 *
 * 这一组测试盯的是三件事：
 *   1. 页面真的渲染出了那几个钩子（而且不能预览的文件不该出现按钮）
 *   2. 样式里的层级是对的（盖住导航、但别盖住弹窗）
 *   3. **页面渲染的钩子名和客户端查找的名字必须一致** —— 对不上就静默失效
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-fullscreen-test-'));
process.env.DATA_DIR = DATA_DIR;

let auth;
let db;
let materials;
let materialPreviewPage;

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

before(async () => {
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  materials = await import('../src/lib/materials.js');
  ({ materialPreviewPage } = await import('../src/web/pages/materials.js'));
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let seq = 0;

async function makeMaterial(filename, mime = 'application/octet-stream') {
  seq += 1;
  const user = auth.createUser({
    username: `全屏测试${seq}_${Math.random().toString(36).slice(2, 7)}`,
    password: 'test123456',
  });
  const row = await materials.createMaterialFromUpload(
    user.id,
    { filename, mime, data: Buffer.from('x', 'utf8') },
    { title: `全屏测试${seq}` },
  );
  return { user, material: materials.getMaterial(user.id, row.id) };
}

function render(user, material, extra = {}) {
  return materialPreviewPage({
    user,
    material,
    siblings: [],
    textContent: '一些正文',
    officeData: null,
    editFormTemplate: '',
    ...extra,
  }).body;
}

// ============================================================
// 渲染出来的钩子
// ============================================================

describe('★ 预览页要能进全屏', () => {
  test('★ 能预览的文件才有全屏按钮，而且是默认隐藏的', async () => {
    const { user, material } = await makeMaterial('课件.pdf', 'application/pdf');
    const html = render(user, material);

    const btn = /<button[^>]*data-viewer-fullscreen[^>]*>/.exec(html)?.[0] || '';
    assert.ok(btn, '预览页应该有全屏按钮');
    assert.match(btn, /\bhidden\b/,
      '★ 必须默认 hidden：这个按钮要 JS 才管用，没有 JS 时不该摆一个按不动的按钮出来');
    assert.ok(html.includes('全屏'), '按钮上要有「全屏」两个字');
  });

  test('★ 不能预览的文件不该出现全屏按钮（按不了的空按钮最恼人）', async () => {
    // .zip 之类：kind=other，canPreview 为 false，页面走的是「下载原件」那条兜底
    const { user, material } = await makeMaterial('资料包.zip', 'application/zip');
    assert.equal(material.canPreview, false, '前提：这个文件确实不能预览');

    const html = render(user, material);
    assert.ok(!html.includes('data-viewer-fullscreen'), '不能预览时不该有全屏按钮');
  });

  test('★ 预览区带 data-preview-main，退出按钮在它里面', async () => {
    const { user, material } = await makeMaterial('讲义.pdf', 'application/pdf');
    const html = render(user, material);

    assert.ok(html.includes('data-preview-main'), '预览区要有 data-preview-main');

    const mainAt = html.indexOf('data-preview-main');
    const sideAt = html.indexOf('preview-side');
    const exitAt = html.indexOf('data-viewer-exit');
    assert.ok(exitAt > -1, '要有退出全屏按钮');
    assert.ok(exitAt > mainAt && exitAt < sideAt,
      '★ 退出按钮必须在 .preview-main **里面**：它是靠 .preview-main.is-immersive 才显示的，'
      + '放到外面就永远不显示（或永远显示）');
  });

  test('★ 两个按钮都带文字，不是只有图标（图标看不懂是什么意思）', async () => {
    const { user, material } = await makeMaterial('讲义2.pdf', 'application/pdf');
    const html = render(user, material);

    // 把图标剥掉再看剩下有没有文字：SVG 有一两百个字符，
    // 直接 includes('全屏') 会连页面别处的字样也算进来，等于没验
    const textOf = (attr) => {
      const tag = new RegExp(`<button[^>]*${attr}[\\s\\S]*?</button>`).exec(html)?.[0] || '';
      return tag.replace(/<svg[\s\S]*?<\/svg>/g, '');
    };

    assert.match(textOf('data-viewer-fullscreen'), /全屏/, '进入按钮上要有文字');
    assert.match(textOf('data-viewer-exit'), /退出全屏/, '退出按钮上要有文字');
  });

  test('幻灯片 / 文字 / 网页版 Office 这些模式也都有全屏按钮', async () => {
    // 全屏是加在 .preview-main 上的，与具体渲染方式无关 ——
    // 这里正着验一遍，防止以后有人把它绑到某一种模式上
    const cases = [
      ['讲义.txt', 'text/plain'],
      ['讲稿.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ];
    for (const [name, mime] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const { user, material } = await makeMaterial(name, mime);
      // eslint-disable-next-line no-await-in-loop
      const html = render(user, material);
      assert.ok(html.includes('data-viewer-fullscreen'), `${name} 也该有全屏按钮`);
      assert.ok(html.includes('data-viewer-exit'), `${name} 也该有退出按钮`);
    }
  });
});

// ============================================================
// 样式
// ============================================================

describe('★ 全屏态的样式', () => {
  const cssRaw = read('src/web/public/app.css');
  // ⚠️ 匹配前必须去掉注释：这几条规则上面就写着注释，里面有
  // 「底部导航(z-index: 50)」这种字样，不去注释的话正则会先匹配到注释里的数字。
  // （这类「守卫被自己的注释骗了」的坑以前踩过一次，所以这里显式处理。）
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

  /** 取出某条规则的正文（从 selector 起到第一个右括号） */
  const ruleBody = (selector, { last = false } = {}) => {
    const at = last ? css.lastIndexOf(`${selector} {`) : css.indexOf(`${selector} {`);
    assert.ok(at > -1, `样式里应该有 ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };

  /** 读出某条规则里的 z-index */
  const zIndexOf = (selector, opts) => {
    const z = Number(/z-index:\s*(\d+)/.exec(ruleBody(selector, opts))?.[1]);
    assert.ok(Number.isFinite(z), `${selector} 里应该写了 z-index`);
    return z;
  };

  test('★ 全屏态靠 fixed + inset:0 铺满，不依赖 Fullscreen API', () => {
    const body = ruleBody('.preview-main.is-immersive');
    assert.match(body, /position:\s*fixed/, '要 fixed');
    assert.match(body, /inset:\s*0/, '要铺满四条边');
  });

  test('★ 层级要盖住导航、但不能盖住弹窗', () => {
    const z = zIndexOf('.preview-main.is-immersive');

    // 手机底部导航固定在底部，全屏时必须盖住它，否则底下一直挡一条
    const tabbarZ = zIndexOf('.tabbar', { last: true });
    assert.ok(z > tabbarZ, `全屏(${z}) 要盖过底部导航(${tabbarZ})`);

    // 弹窗/确认条/提示条/看图器的层级是写在样式表文件头的约定，别破坏它：
    // 全屏如果盖住弹窗，全屏时「编辑」之类的弹窗就点不到了
    for (const [label, selector] of [
      ['确认条', '.check-confirm'],
      ['弹窗', '.modal-backdrop'],
      ['提示条', '.toast-stack'],
      ['看图器', '.slide-viewer'],
    ]) {
      const other = zIndexOf(selector);
      assert.ok(other > z, `${label}(${other}) 要盖过全屏(${z})，否则全屏时它会被压在下面点不到`);
    }
  });

  test('★ 退出按钮默认不显示，只有全屏态才出现', () => {
    assert.match(ruleBody('.viewer-exit'), /display:\s*none/,
      '平时必须藏起来（否则页面上凭空多一个按钮）');
    assert.match(ruleBody('.preview-main.is-immersive .viewer-exit'), /display:\s*inline-flex/);
  });

  test('★ PDF 高度用 dvh，不用 vh（手机上地址栏会变）', () => {
    const body = ruleBody('.preview-main.is-immersive .viewer__frame');
    assert.match(body, /100dvh/,
      '用 dvh：手机上地址栏收起/展开时 vh 不变，底部会空一条或被顶出屏幕');
    assert.match(body, /100vh/, '同时留一行 vh 作为老浏览器的兜底');
  });

  test('全屏时去掉卡片边框圆角，空间全给内容', () => {
    const body = ruleBody('.preview-main.is-immersive .viewer');
    assert.match(body, /border:\s*0/);
    assert.match(body, /border-radius:\s*0/);
  });
});

// ============================================================
// 客户端接线
// ============================================================

describe('★ 客户端接线（这类不一致会静默失效）', () => {
  const app = read('src/web/public/app.js');

  test('★ initMaterialViewer 有定义，而且在 boot 里被调用了', () => {
    assert.match(app, /function initMaterialViewer\(\)/, '要有这个函数');
    assert.match(app, /\n\s+initMaterialViewer\(\);/, '★ 定义了但忘记调用的话，整个功能就是不生效');
  });

  test('★ 页面渲染的钩子名和客户端查找的名字必须一模一样', async () => {
    const { user, material } = await makeMaterial('钩子.pdf', 'application/pdf');
    const html = render(user, material);

    // 从**渲染出来的 HTML** 里抠出 data-* 钩子名，再要求客户端也写了同样的字符串。
    // 只查源码两边各写一遍是靠不住的：名字打错一个字母，两边各自都合法，
    // 结果就是点了没反应、而且不报错。
    const hooks = new Set();
    for (const m of html.matchAll(/data-(viewer-fullscreen|viewer-exit|preview-main)\b/g)) {
      hooks.add(m[1]);
    }
    assert.equal(hooks.size, 3, `三个钩子都该出现在页面里，实际只有 ${[...hooks].join(', ')}`);

    for (const hook of hooks) {
      assert.ok(app.includes(`data-${hook}`),
        `★ 页面渲染了 data-${hook}，但客户端没有找它 —— 这个按钮会点了没反应`);
    }
  });

  test('★ 退出全屏不能只靠原生 API：Esc 也要自己处理', () => {
    // iPhone 上没有原生全屏，只能靠 keydown 里的 Esc 分支退出
    assert.match(app, /e\.key !== 'Escape'/, '要有 Esc 处理');
    assert.match(app, /fullscreenElement/, '要判断当前是不是原生全屏');
  });

  test('★ 原生全屏退出时要同步收掉 CSS 那一层', () => {
    // 不然用户按 F11/Esc 退出原生全屏后，页面还留着「铺满」状态，
    // 导航看不见、退出按钮却还在，只能刷新
    assert.match(app, /addEventListener\('fullscreenchange'/, '要监听原生全屏的变化');
    assert.match(app, /isImmersive\(\)\)\s*main\.classList\.remove\('is-immersive'\)/,
      '退出原生全屏时要顺手把 is-immersive 去掉');
  });

  test('★ 看图器开着时，Esc 先关它，不要连全屏一起退', () => {
    assert.match(app, /\.slide-viewer/, '要判断看图器是否开着');
  });
});
