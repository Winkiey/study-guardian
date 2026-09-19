/**
 * PDF 预览在 iPhone / iPad 上的提示。
 *
 * 需求：「把这个提示直接写在 PDF 预览的界面上」。
 *
 * 背景：iOS Safari 在 <iframe> 里渲染 PDF 时**只画第一页，而且不给滚动**。
 * 服务器上的课件现在大多是 LibreOffice 转出来的 PDF，所以手机上打开资料页
 * 看到的是一份「只有一页的课件」，很容易以为是文件传坏了。
 * 修不了那条限制（那是苹果的行为），但可以告诉用户换个打开方式 ——
 * 新标签页会交给 iOS 自带的 PDF 阅读器，翻页、缩放、搜索都正常。
 *
 * 这一组测试盯三件事：
 *   1. 提示真的渲染出来了、默认是藏着的、位置在 iframe 上面
 *   2. 只有 PDF 模式才有它（别的模式本来就是好的，多一块提示是噪音）
 *   3. **[hidden] 属性本身并不隐藏任何东西** —— 这一点单独拎出来测，见下面
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-ios-notice-test-'));
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
    username: `iOS提示${seq}_${Math.random().toString(36).slice(2, 7)}`,
    password: 'test123456',
  });
  const row = await materials.createMaterialFromUpload(
    user.id,
    { filename, mime, data: Buffer.from('x', 'utf8') },
    { title: `iOS提示${seq}` },
  );
  return { user, material: materials.getMaterial(user.id, row.id) };
}

function render(user, material) {
  return materialPreviewPage({
    user,
    material,
    siblings: [],
    textContent: '一些正文',
    officeData: null,
    editFormTemplate: '',
  }).body;
}

/** 把提示块那一整段抠出来。
 *  不用「数 <div> 配对」那种正则 —— 块里有嵌套 div、还有 <a>，
 *  写起来容易对不上（第一版就是这么写错的）。提示块后面紧跟着 iframe，
 *  用它当右边界最省事也最准。 */
function noticeBlock(html) {
  const at = html.indexOf('data-ios-pdf-notice');
  if (at < 0) return '';
  const end = html.indexOf('<iframe', at);
  return html.slice(at, end < 0 ? html.length : end);
}

// ============================================================
// 渲染出来的提示
// ============================================================

describe('★ PDF 预览里的 iOS 提示', () => {
  test('★ PDF 预览里有这块提示，而且默认是 hidden 的', async () => {
    const { user, material } = await makeMaterial('讲义.pdf', 'application/pdf');
    const html = render(user, material);

    const tag = /<div[^>]*data-ios-pdf-notice[^>]*>/.exec(html)?.[0] || '';
    assert.ok(tag, 'PDF 预览里应该有这块提示');
    assert.match(tag, /\bhidden\b/,
      '★ 必须默认 hidden：桌面浏览器点开 PDF 是好的，不该看到这条只在手机上成立的提示');
  });

  test('★ 提示排在 iframe 前面（用户要先看到它，而不是先纳闷）', async () => {
    const { user, material } = await makeMaterial('讲义2.pdf', 'application/pdf');
    const html = render(user, material);

    const noticeAt = html.indexOf('data-ios-pdf-notice');
    const frameAt = html.indexOf('<iframe');
    assert.ok(noticeAt > -1 && frameAt > -1, '前提：两样东西都得在');
    assert.ok(noticeAt < frameAt,
      '★ 放在 iframe 后面的话，用户会先盯着一份「只有一页」的 PDF 看半天才滚到提示');
  });

  test('★ 只有 PDF 模式才有它（别的模式本来就是好的）', async () => {
    // 幻灯片图片模式是逐页导出的 PNG，在 iOS 上完全正常；
    // 文字版、网页版 Office 也没有这个问题。给它们加提示纯属噪音。
    const cases = [
      ['笔记.txt', 'text/plain'],
      ['讲稿.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ];
    for (const [name, mime] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const { user, material } = await makeMaterial(name, mime);
      // eslint-disable-next-line no-await-in-loop
      const html = render(user, material);
      assert.ok(!html.includes('data-ios-pdf-notice'), `${name}（${material.previewMode}）不该有这块提示`);
    }
  });

  test('★ 幻灯片图片模式也不该有它', async () => {
    // ⚠️ 光验文字版和 Office 是不够的：A/B 注入时发现，
    //    把提示误加进 slides 那条分支，上面那个用例照样是全绿的。
    //    slides 模式在真实环境里是 PPT 的**主要**形态（服务器上都是转成图片的），
    //    所以这里必须单独覆盖一次。
    const { user, material } = await makeMaterial('课件.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation');

    // 真实流程里 slides_dir 是转换器写上去的；这里直接补上这一列，
    // 免得为了一个渲染判断去跑一遍 LibreOffice。
    db.getDb().prepare('UPDATE materials SET slides_dir = ? WHERE id = ?')
      .run('slides/', material.id);

    const fresh = materials.getMaterial(user.id, material.id);
    assert.equal(fresh.previewMode, 'slides', '前提：这个文件现在确实是幻灯片图片模式');

    const html = render(user, fresh);
    assert.ok(html.includes('slide-deck'), '前提：渲染出来的确实是幻灯片');
    assert.ok(!html.includes('data-ios-pdf-notice'),
      '★ 幻灯片图片模式不该有这块提示：每页都是图，手机上本来就是好的');
  });

  test('★ 提示给了能用的出口，不是只说一句「不支持」', async () => {
    const { user, material } = await makeMaterial('讲义3.pdf', 'application/pdf');
    const html = render(user, material);

    const block = noticeBlock(html);
    assert.ok(block, '应该能抠出提示块');

    const link = /<a[^>]*href="([^"]+)"[^>]*>/.exec(block);
    assert.ok(link, '提示里得有一个链接，光说「打不开」等于没帮上忙');
    assert.equal(link[1], `/materials/${material.id}/pdf`,
      '要指向 PDF 本身（不能带 ?download=1：手机上更该直接看，而不是存到文件里）');
    assert.match(link[0], /target="_blank"/,
      '★ 必须新标签页打开：在原窗口跳走的话，从桌面图标进来的 PWA 就没有返回按钮了');
    assert.match(link[0], /rel="noopener"/, '新窗口链接要带 rel="noopener"');
  });

  test('提示文字说清「是浏览器的限制、不是文件坏了」', async () => {
    const { user, material } = await makeMaterial('讲义4.pdf', 'application/pdf');
    const html = render(user, material);
    const block = noticeBlock(html);

    // 这两件事都得说到：用户第一个念头是「上传失败了」或「文件坏了」，
    // 先把这个念头掐掉，他才愿意看后面那句「请用新标签页打开」
    assert.match(block, /苹果|Safari/, '要说明这是谁的限制');
    assert.match(block, /第一页/, '要说清具体现象（只显示第一页），否则用户不知道自己遇到的是不是这个');
  });
});

// ============================================================
// [hidden] 属性并不隐藏任何东西 —— 这个是踩过的坑
// ============================================================

describe('★ [hidden] 必须真的隐藏', () => {
  const cssRaw = read('src/web/public/app.css');
  // 匹配前先去掉注释：本文件在这条规则上方就写着注释，
  // 里面可能出现 "display" 之类的字样（守卫被自己的注释骗过一次了）
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

  const ruleBody = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at > -1, `样式里应该有 ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };

  test('★ 基础层有 [hidden] { display: none !important }', () => {
    const body = ruleBody('[hidden]');
    assert.match(body, /display:\s*none/, '[hidden] 必须是 display: none');
    assert.match(body, /!important/,
      '★ 必须带 !important —— 见下一条，同权重、又写在组件前面，不带就赢不了');
  });

  test('★ 组件的 display 确实会盖掉浏览器默认的 [hidden]（所以上一条不是多余的）', () => {
    // 浏览器默认样式里的 [hidden] { display: none } 属于最低那一档，
    // 作者样式里任何一条 display 都能盖掉它。本文件至少这两个组件就是这么干的：
    assert.match(ruleBody('.btn'), /display:\s*inline-flex/, '前提：.btn 自己设了 display');
    assert.match(ruleBody('.notice'), /display:\s*flex/, '前提：.notice 自己设了 display');

    // 这两条规则都在文件后半部分，位置也在 [hidden] 之后，
    // 于是「同权重 + 更靠后」= 组件赢。这就是为什么必须 !important。
    //
    // ⚠️ 这里必须先把 [hidden] 的位置查出来再比。
    //    直接写 `indexOf('.btn {') > indexOf('[hidden] {')` 是个假通过：
    //    规则被删掉时 indexOf 返回 -1，而「任何数 > -1」都成立，断言照样绿。
    //    （A/B 注入时就是这么发现的。）
    const hiddenAt = css.indexOf('[hidden] {');
    assert.ok(hiddenAt > -1, '前提：基础层那条 [hidden] 规则得在，否则这个比较没有意义');
    assert.ok(css.indexOf('.btn {') > hiddenAt,
      '前提：[hidden] 写在基础层、在这些组件之前');
  });

  test('★ 全屏按钮和 iOS 提示都依赖这条规则', async () => {
    // 这两处都用了 hidden 属性，一旦那条规则被人删掉，
    // 它们会**在所有设备上**冒出来：一个是点了没反应的按钮，一个是手机上才成立的提示。
    const { user, material } = await makeMaterial('讲义5.pdf', 'application/pdf');
    const html = render(user, material);
    assert.match(html, /<button[^>]*data-viewer-fullscreen[^>]*\bhidden\b/, '全屏按钮要带 hidden');
    assert.match(html, /<div[^>]*data-ios-pdf-notice[^>]*\bhidden\b/, 'iOS 提示要带 hidden');
  });

  test('★ 表单弹窗里的错误框也靠这条规则（这是被顺手修好的老毛病）', () => {
    // 这条规则不是为 iOS 提示新加的，它同时修掉了一个**早就存在**的显示 bug：
    // 保存上课时间 / 批量改学分这两个弹窗里的错误框是
    // `.notice`（display: flex）+ hidden 属性 —— 也就是说以前 hidden 根本没生效：
    //   1. 弹窗一打开就先摆一个空的红色错误框（没内容，只有一个警告图标）
    //   2. 报错之后用户改对了再提交，hideError() 也消不掉那行红字，一直挂在上面
    // 这里把这两处钉住，免得以后有人觉得那条规则「没什么用」就删掉。
    const app = read('src/web/public/app.js');
    for (const hook of ['data-session-error', 'data-batch-error']) {
      const tag = new RegExp(`<div[^>]*class="notice notice--error[^"]*"[^>]*${hook}[^>]*>`).exec(app)?.[0] || '';
      assert.ok(tag, `app.js 里应该有 ${hook} 那个错误框`);
      assert.match(tag, /\bhidden\b/, `${hook} 默认要带 hidden（否则一打开弹窗就是个空红框）`);
    }
  });
});

// ============================================================
// iOS 判断
// ============================================================

describe('★ iOS 判断（UA 那一套有坑）', () => {
  const app = read('src/web/public/app.js');

  /** 把 isIosDevice 从 app.js 里抠出来，在假 navigator 上真跑一遍。
   *  只 grep 源码里有没有 "iPad" 这种字符串是测不出逻辑对错的。 */
  const source = (() => {
    const m = /function isIosDevice\(\) \{[\s\S]*?\n\}/.exec(app);
    assert.ok(m, 'app.js 里应该有 isIosDevice()');
    // eslint-disable-next-line no-new-func
    return m[0];
  })();

  const detect = (userAgent, maxTouchPoints) =>
    // eslint-disable-next-line no-new-func
    new Function('navigator', `${source}\nreturn isIosDevice();`)({ userAgent, maxTouchPoints });

  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
  // iPadOS 13 起 Safari 的 UA 和真 Mac 一模一样，只能靠触摸点数区分
  const IPADOS_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const REAL_MAC = IPADOS_AS_MAC;

  test('★ iPhone / iPad 认出来', () => {
    assert.equal(detect(IPHONE, 5), true);
    assert.equal(detect(IPAD, 5), true);
  });

  test('★ Android 不算 iOS（Chrome 上内嵌 PDF 是另一回事）', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
    assert.equal(detect(android, 5), false, 'Android 的 UA 里有 Mobile/Safari，别被误判');
  });

  test('★ iPadOS 13+ 伪装成 Macintosh 时，靠触摸点数认出来', () => {
    assert.equal(detect(IPADOS_AS_MAC, 5), true,
      '★ iPad 上 maxTouchPoints > 1；漏了这条的话新 iPad 看不到提示');
  });

  test('★ 真 Mac 不能误判（Mac 上内嵌 PDF 是正常的）', () => {
    assert.equal(detect(REAL_MAC, 0), false,
      '★ 只看 "Macintosh" 会把所有 Mac 用户也算进来，那就得给不该看的人看提示');
  });

  test('Windows 桌面浏览器不算', () => {
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    assert.equal(detect(win, 0), false);
  });

  test('没有 userAgent（爬虫 / 老环境）时不能崩', () => {
    assert.doesNotThrow(() => detect(undefined, 0));
    assert.equal(detect(undefined, 0), false);
    assert.equal(detect('', undefined), false, 'maxTouchPoints 缺失时不该当成 iPad');
  });
});

// ============================================================
// 客户端接线
// ============================================================

describe('★ 客户端接线（对不上就静默失效）', () => {
  const app = read('src/web/public/app.js');

  test('★ initIosPdfNotice 有定义，而且在 boot 里被调用了', () => {
    assert.match(app, /function initIosPdfNotice\(\)/, '要有这个函数');
    assert.match(app, /\n\s+initIosPdfNotice\(\);/, '★ 定义了但忘记调用的话，提示永远不会出现');
  });

  test('★ 页面渲染的钩子名和客户端查找的名字必须一模一样', async () => {
    const { user, material } = await makeMaterial('钩子.pdf', 'application/pdf');
    const html = render(user, material);

    // 从**渲染出来的 HTML** 里抠出钩子名，再要求客户端也写了同样的字符串。
    // 两边各写一遍是靠不住的：错一个字母两边各自都合法，结果是提示永远不出现、也不报错。
    const hooks = new Set();
    for (const m of html.matchAll(/data-(ios-pdf-notice)\b/g)) hooks.add(m[1]);
    assert.equal(hooks.size, 1, '页面里应该有 data-ios-pdf-notice');

    for (const hook of hooks) {
      assert.ok(app.includes(`data-${hook}`),
        `★ 页面渲染了 data-${hook}，但客户端没有找它 —— 这块提示等于白写了`);
    }
  });

  test('★ 客户端只负责去掉 hidden，不负责塞内容（内容要服务端就渲染好）', () => {
    // 文案如果靠 JS 拼，那么禁用 JS 或者 JS 报错时提示就是空的。
    // 这里是「服务端渲染 + JS 只切状态」的既有做法。
    assert.match(app, /notice\.hidden = false/, '应该是把 hidden 去掉');
    assert.ok(!/notice\.innerHTML/.test(app), '不该用 JS 往提示里塞 HTML');
  });
});
