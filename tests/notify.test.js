/**
 * 通知渠道的单元测试，目前聚焦 Bark。
 *
 * 这里测的都是用户真实反馈过、或者一定会踩的坑：
 *
 * 1. Bark App 首页显示的是一整段网址（https://api.day.app/AbCdEf123456），
 *    用户很容易整段复制粘贴进「推送 Key」框。原先把这串直接当 Key 发给
 *    Bark，服务器只回一句英文「device token is not exists」，用户完全
 *    不知道错在哪。现在要能自动拆成「服务器地址 + Key」。
 *
 * 2. Bark 的英文报错要翻译成人话。
 *
 * 3. 只发 POST /push 不够：老版本/自建 Bark 可能只认 POST /{key} 这种路径写法。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// channels.js 会连带加载 smtp.js → config.js，后者会创建 data 目录和密钥。
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-notify-test-'));

let getChannelDef;
let explainBarkError;
let explainNetworkFailure;
let channelCatalog;

before(async () => {
  const mod = await import('../src/lib/notify/channels.js');
  ({ getChannelDef, explainBarkError, explainNetworkFailure, channelCatalog } = mod);
});

/** 取 Bark 渠道定义 */
function bark() {
  const def = getChannelDef('bark');
  assert.ok(def, 'Bark 渠道应该存在');
  return def;
}

/** 跑一遍 Bark 的 normalize */
function norm(config) {
  const def = bark();
  assert.equal(typeof def.normalize, 'function', 'Bark 应该实现 normalize');
  return def.normalize(config);
}

// ============================================================
// normalize：把用户粘的东西整理成能用的
// ============================================================

describe('Bark normalize · 粘贴完整网址', () => {
  test('★ 推送 Key 里粘的是完整网址 → 自动拆成服务器地址和 Key', () => {
    const out = norm({ key: 'https://api.day.app/AbCdEf123456' });
    assert.equal(out.key, 'AbCdEf123456');
    assert.equal(out.server, 'https://api.day.app');
  });

  test('★ 不带协议头的完整网址也能拆', () => {
    const out = norm({ key: 'api.day.app/AbCdEf123456' });
    assert.equal(out.key, 'AbCdEf123456');
    assert.equal(out.server, 'https://api.day.app');
  });

  test('网址结尾带斜杠也能拆', () => {
    const out = norm({ key: 'https://api.day.app/AbCdEf123456/' });
    assert.equal(out.key, 'AbCdEf123456');
  });

  test('网址前后带空格能拆（复制粘贴常见）', () => {
    const out = norm({ key: '  https://api.day.app/AbCdEf123456  ' });
    assert.equal(out.key, 'AbCdEf123456');
  });

  test('Key 里的换行会被清掉', () => {
    const out = norm({ key: 'AbCdEf\n123456' });
    assert.equal(out.key, 'AbCdEf123456');
  });

  test('自建服务器地址不会被网址里的域名冲掉', () => {
    const out = norm({
      server: 'https://bark.mysite.com',
      key: 'https://api.day.app/AbCdEf123456',
    });
    // Key 提取出来
    assert.equal(out.key, 'AbCdEf123456');
    // 但服务器地址保留用户自己填的
    assert.equal(out.server, 'https://bark.mysite.com');
  });

  test('服务器地址还是官方默认值时，允许被网址里的域名覆盖', () => {
    const out = norm({
      server: 'https://api.day.app',
      key: 'https://bark.mysite.com/AbCdEf123456',
    });
    assert.equal(out.server, 'https://bark.mysite.com');
    assert.equal(out.key, 'AbCdEf123456');
  });

  test('普通的 Key 原样保留', () => {
    const out = norm({ key: 'AbCdEf123456' });
    assert.equal(out.key, 'AbCdEf123456');
  });

  test('★ 只有斜杠的奇怪输入不会被误当成网址', () => {
    const out = norm({ key: 'abc/def' });
    assert.equal(out.key, 'abc/def', '太短的后半段不该被当成 Key');
  });
});

describe('Bark normalize · 服务器地址', () => {
  test('★ 服务器地址少了 https:// 会补上', () => {
    assert.equal(norm({ server: 'api.day.app', key: 'k' }).server, 'https://api.day.app');
  });

  test('★ 服务器地址结尾的斜杠会被去掉（否则拼出 //push）', () => {
    assert.equal(norm({ server: 'https://api.day.app/', key: 'k' }).server, 'https://api.day.app');
    assert.equal(norm({ server: 'https://api.day.app///', key: 'k' }).server, 'https://api.day.app');
  });

  test('服务器地址留空 → 用官方地址', () => {
    assert.equal(norm({ key: 'AbCdEf123456' }).server, 'https://api.day.app');
    assert.equal(norm({ server: '', key: 'AbCdEf123456' }).server, 'https://api.day.app');
    assert.equal(norm({ server: '   ', key: 'AbCdEf123456' }).server, 'https://api.day.app');
  });

  test('http:// 不会被强行升级成 https://', () => {
    assert.equal(norm({ server: 'http://192.168.1.5:8080', key: 'k' }).server, 'http://192.168.1.5:8080');
  });

  test('服务器地址里粘了带 Key 的网址 → 域名给 server，Key 给 key', () => {
    const out = norm({ server: 'https://api.day.app/AbCdEf123456' });
    assert.equal(out.server, 'https://api.day.app');
    assert.equal(out.key, 'AbCdEf123456');
  });

  test('服务器地址粘了带 Key 的网址、但 Key 框已经填了 → 不覆盖已有的 Key', () => {
    const out = norm({ server: 'https://api.day.app/AbCdEf123456', key: 'MyOwnKey123' });
    assert.equal(out.key, 'MyOwnKey123');
  });

  test('normalize 不会就地修改传入的对象', () => {
    const input = { key: 'https://api.day.app/AbCdEf123456', server: '' };
    const out = norm(input);
    assert.equal(input.key, 'https://api.day.app/AbCdEf123456', '原对象应保持不变');
    assert.notEqual(out, input);
  });

  test('其它字段（level/sound/group）原样带过去', () => {
    const out = norm({ key: 'k', level: 'critical', sound: 'alarm', group: '作业' });
    assert.equal(out.level, 'critical');
    assert.equal(out.sound, 'alarm');
    assert.equal(out.group, '作业');
  });
});

// ============================================================
// explainBarkError：英文报错翻译成人话
// ============================================================

describe('Bark 报错翻译', () => {
  test('★ device token is not exists → 提示去 App 首页复制 Key', () => {
    const msg = explainBarkError('device token is not exists', 400, 'https://api.day.app', 'AbCdEf123456');
    assert.match(msg, /推送 Key 不对/);
    assert.match(msg, /Bark App/);
    // 要带上用户填的前几位，方便对照
    assert.match(msg, /AbCdEf/);
  });

  test('★ Key 错误时不再把英文原文当主信息甩给用户', () => {
    const msg = explainBarkError('device token is not exists', 400, 'https://api.day.app', 'xyz');
    assert.ok(!msg.startsWith('推送失败：device token'), '中文解释要放在最前面');
  });

  test('device not found 也有中文解释', () => {
    const msg = explainBarkError('device not found', 400, 'https://api.day.app', 'abc123');
    assert.match(msg, /找不到这个设备/);
  });

  test('404 → 提示检查服务器地址', () => {
    const msg = explainBarkError('', 404, 'https://wrong.example.com', 'abc123');
    assert.match(msg, /推送接口不存在/);
    assert.match(msg, /wrong\.example\.com/);
  });

  test('401/403 → 提示自建服务端的鉴权', () => {
    assert.match(explainBarkError('', 401, 'https://b.com', 'k'), /拒绝/);
    assert.match(explainBarkError('', 403, 'https://b.com', 'k'), /拒绝/);
  });

  test('429 → 提示限流', () => {
    assert.match(explainBarkError('', 429, 'https://api.day.app', 'k'), /限流/);
  });

  test('完全不认识的报错也会带上服务器地址，方便排查', () => {
    const msg = explainBarkError('something weird', 500, 'https://b.com', 'k');
    assert.match(msg, /something weird/);
    assert.match(msg, /https:\/\/b\.com/);
  });

  test('没有任何信息的失败也有兜底文案', () => {
    const msg = explainBarkError('', 500, 'https://b.com', 'k');
    assert.match(msg, /HTTP 500/);
  });
});

// ============================================================
// explainNetworkFailure：连不上时也得说人话
// ============================================================

describe('网络错误翻译', () => {
  /** 拼一个 undici 风格的错误：message 是废话，真原因在 cause 里 */
  function fetchError(code, extra = {}) {
    const err = new Error('fetch failed');
    err.cause = { code, message: `connect ${code}`, ...extra };
    return err;
  }

  test('★ ECONNREFUSED → 提示服务器地址或端口不对（而不是 "fetch failed"）', () => {
    const msg = explainNetworkFailure(fetchError('ECONNREFUSED', { address: '127.0.0.1', port: 1 }));
    assert.match(msg, /连不上服务器/);
    assert.match(msg, /服务器地址|端口/);
    assert.match(msg, /127\.0\.0\.1:1/, '要带上具体地址，方便照抄核对');
    assert.ok(!msg.includes('fetch failed'), '不能出现英文原文');
  });

  test('★ ENOTFOUND → 提示域名可能打错了', () => {
    const msg = explainNetworkFailure(fetchError('ENOTFOUND'));
    assert.match(msg, /解析不了/);
    assert.match(msg, /打错|网络/);
  });

  test('ETIMEDOUT → 提示超时', () => {
    assert.match(explainNetworkFailure(fetchError('ETIMEDOUT')), /超时/);
  });

  test('证书类错误 → 提示证书问题', () => {
    assert.match(explainNetworkFailure(fetchError('CERT_HAS_EXPIRED')), /证书/);
    assert.match(explainNetworkFailure(fetchError('DEPTH_ZERO_SELF_SIGNED_CERT')), /自签名证书/);
  });

  test('★ bad port → 提示地址不合法（不是干巴巴一句 bad port）', () => {
    const err = new Error('fetch failed');
    err.cause = { message: 'bad port' };
    const msg = explainNetworkFailure(err);
    assert.match(msg, /服务器地址不合法/);
    assert.match(msg, /bad port/, '原话要留着，方便搜索');
  });

  test('认不出的错误也不会丢掉原始信息', () => {
    const msg = explainNetworkFailure(fetchError('EWEIRD'));
    assert.match(msg, /网络请求失败/);
    assert.match(msg, /EWEIRD/);
  });

  test('宽松入参：没有 cause 也不抛异常', () => {
    assert.doesNotMatch(explainNetworkFailure(new Error('boom')), /undefined/);
    assert.match(explainNetworkFailure(undefined), /网络请求失败|失败/);
  });
});

// ============================================================
// send：调用方式与回退
// ============================================================

/**
 * 起一个本地假 Bark 服务器，记录收到的请求。
 *
 * 所有起过的服务器都记在 openServers 里，由 after() 统一关闭。
 * 不能让每个测试自己 close：断言一失败就跳过了 close，
 * 监听的端口会让 Node 进程永远不退出，测试挂死。
 */
const openServers = [];

function startFakeBark(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 忽略 */ }
      requests.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const fake = {
        server,
        requests,
        base: `http://127.0.0.1:${port}`,
      };
      openServers.push(server);
      resolve(fake);
    });
  });
}

function jsonReply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const MSG = { title: '作业提醒', body: '高等数学 明天 23:59 截止' };

describe('Bark send', () => {
  after(async () => {
    await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
    openServers.length = 0;
  });

  /** 起一个新的假服务器，让每个测试互不干扰 */
  function fresh(handler) {
    return startFakeBark(handler);
  }

  test('★ 首选 POST /push，用 device_key 传 Key', async () => {
    const fake = await fresh((req, res) => jsonReply(res, 200, { code: 200, message: 'success' }));

    const result = await bark().send({ server: fake.base, key: 'MyKey123', sound: 'bell' }, MSG);
    assert.equal(result.ok, true);

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].method, 'POST');
    assert.equal(fake.requests[0].url, '/push');
    assert.equal(fake.requests[0].body.device_key, 'MyKey123');
    assert.equal(fake.requests[0].body.title, '作业提醒');
    assert.equal(fake.requests[0].body.sound, 'bell');
  });

  test('★ /push 不存在时回退到 POST /{key}（兼容老版本 Bark）', async () => {
    const fake = await fresh((req, res) => {
      if (req.url === '/push') return jsonReply(res, 404, { code: 404, message: 'not found' });
      jsonReply(res, 200, { code: 200, message: 'success' });
    });

    const result = await bark().send({ server: fake.base, key: 'MyKey123' }, MSG);
    assert.equal(result.ok, true, '回退应该成功');

    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1].url, '/MyKey123');
    // 路径写法里 Key 在 URL 上，body 里不应该再带 device_key
    assert.equal(fake.requests[1].body.device_key, undefined);
  });

  test('★ Key 不对时不做无谓的第二次重试', async () => {
    const fake = await fresh((req, res) => jsonReply(res, 400, {
      code: 400, message: 'device token is not exists',
    }));

    await assert.rejects(
      () => bark().send({ server: fake.base, key: 'BadKey' }, MSG),
      (err) => {
        assert.match(err.message, /推送 Key 不对/);
        return true;
      },
    );

    // 两种调用方式对同一个错 Key 都会失败，只试一次就够
    assert.equal(fake.requests.length, 1, '不该白跑第二遍');
  });

  test('★ 报错信息是中文，且提到是哪个服务器', async () => {
    const fake = await fresh((req, res) => jsonReply(res, 500, { code: 500, message: 'boom' }));

    await assert.rejects(
      () => bark().send({ server: fake.base, key: 'k123456' }, MSG),
      (err) => {
        assert.match(err.message, /推送失败/);
        assert.match(err.message, /boom/);
        assert.ok(err.message.includes(fake.base), '要带上服务器地址');
        return true;
      },
    );
  });

  test('没填 Key 就直接拦下，不发请求', async () => {
    await assert.rejects(
      () => bark().send({ server: 'http://127.0.0.1:1' }, MSG),
      /Key|必填|不能为空|配置不完整/,
    );
  });

  test('★ Key 里带了换行/空格也能发出去（复制粘贴常见）', async () => {
    const fake = await fresh((req, res) => jsonReply(res, 200, { code: 200 }));

    await bark().send({ server: fake.base, key: ' AbCdEf\n123456 ' }, MSG);
    assert.equal(fake.requests[0].body.device_key, 'AbCdEf123456');
  });

  test('★ send 自己也认完整网址（不依赖调用方先规范化）', async () => {
    const fake = await fresh((req, res) => jsonReply(res, 200, { code: 200 }));

    // 服务器地址写成假服务器，Key 里粘的是官方网址
    await bark().send({ server: fake.base, key: 'https://api.day.app/AbCdEf123456' }, MSG);
    assert.equal(fake.requests[0].url, '/push');
    assert.equal(fake.requests[0].body.device_key, 'AbCdEf123456');
  });

  test('默认级别是 timeSensitive（能穿透专注模式）', async () => {
    const fake = await fresh((req, res) => jsonReply(res, 200, { code: 200 }));

    await bark().send({ server: fake.base, key: 'k123456' }, MSG);
    assert.equal(fake.requests[0].body.level, 'timeSensitive');
  });

  test('默认分组是「学习守护」', async () => {
    const fake = await fresh((req, res) => jsonReply(res, 200, { code: 200 }));

    await bark().send({ server: fake.base, key: 'k123456' }, MSG);
    assert.equal(fake.requests[0].body.group, '学习守护');
  });

  test('消息里的链接会带过去', async () => {
    const fake = await fresh((req, res) => jsonReply(res, 200, { code: 200 }));

    await bark().send({ server: fake.base, key: 'k123456' }, { ...MSG, url: 'http://localhost:3081/assignments' });
    assert.equal(fake.requests[0].body.url, 'http://localhost:3081/assignments');
  });
});

// ============================================================
// 面向设置页的元数据
// ============================================================

describe('渠道清单', () => {
  test('★ catalog 里带上了 guide，设置页才能显示引导', () => {
    const item = channelCatalog().find((c) => c.type === 'bark');
    assert.ok(item.guide, 'Bark 应该有 guide');
    assert.match(item.guide, /App Store/);
    assert.match(item.guide, /长按/);
  });

  test('★ catalog 不含函数（要能 JSON 序列化进页面）', () => {
    const json = JSON.stringify(channelCatalog());
    assert.ok(json.length > 0);
    for (const c of channelCatalog()) {
      assert.equal(typeof c.send, 'undefined', `${c.type} 的 send 不该被序列化`);
      assert.equal(typeof c.normalize, 'undefined', `${c.type} 的 normalize 不该被序列化`);
    }
  });

  test('Bark 的 sound 是下拉选择，不是自由文本', () => {
    const sound = bark().fields.find((f) => f.key === 'sound');
    assert.equal(sound.type, 'select');
    assert.ok(sound.options.length >= 5);
    // 「留空用默认」要有一个空值选项
    assert.ok(sound.options.some((o) => o.value === ''));
  });

  test('Bark 的 level 是下拉，且覆盖四个级别', () => {
    const level = bark().fields.find((f) => f.key === 'level');
    assert.equal(level.type, 'select');
    const values = level.options.map((o) => o.value).sort();
    assert.deepEqual(values, ['active', 'critical', 'passive', 'timeSensitive']);
    assert.equal(level.default, 'timeSensitive');
  });

  test('★ level 的说明里要提到 iOS 的「时效性通知」开关', () => {
    const level = bark().fields.find((f) => f.key === 'level');
    assert.match(level.help, /时效性通知/);
    assert.match(level.help, /设置/);
  });

  test('★ 推送 Key 的说明里要提到「可以整段粘贴网址」', () => {
    const key = bark().fields.find((f) => f.key === 'key');
    assert.match(key.help, /网址/);
  });

  test('所有渠道的字段结构都是合法的', () => {
    for (const def of channelCatalog()) {
      for (const f of def.fields || []) {
        assert.ok(f.key, `${def.type} 有字段缺少 key`);
        assert.ok(f.label, `${def.type}.${f.key} 缺少 label`);
        if (f.type === 'select') {
          assert.ok(Array.isArray(f.options) && f.options.length, `${def.type}.${f.key} 是 select 但没有选项`);
        }
      }
    }
  });

  test('★ 解析成 HTML 的文案里不能有没转义的尖括号', () => {
    // help / guide 在设置页是按 HTML 渲染的，一个裸的 <xxx> 会被浏览器
    // 当成标签吞掉（真实踩过：邮件的「学习守护 <你的邮箱>」）
    for (const def of channelCatalog()) {
      for (const f of def.fields || []) {
        if (!f.help) continue;
        const stripped = String(f.help).replace(/<\/?(strong|em|br|code|b|i|a|small|span)\b[^>]*>/gi, '');
        assert.ok(
          !/<[a-zA-Z/]/.test(stripped),
          `${def.type}.${f.key} 的 help 里有没转义的标签：${f.help}`,
        );
      }
    }
  });

  test('★ 引导里的标签是配平的（漏一个 </details> 会吞掉后面的表单）', () => {
    // guide 是用 innerHTML 注入的，标签不配平的话浏览器会把后面的输入框
    // 全都塞进那个没关的 <details> 里，用户看到的是一个空表单。
    for (const def of channelCatalog()) {
      if (!def.guide) continue;

      const stack = [];
      const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
      let m;
      while ((m = tagRe.exec(def.guide)) !== null) {
        const [, closing, name, selfClosing] = m;
        const tag = name.toLowerCase();

        // <br> 之类的空元素不需要闭合
        if (selfClosing || ['br', 'hr', 'img', 'input'].includes(tag)) continue;

        if (closing) {
          const expected = stack.pop();
          assert.equal(
            expected,
            tag,
            `${def.type} 的 guide 里 </${tag}> 对不上（此时栈顶是 <${expected}>）`,
          );
        } else {
          stack.push(tag);
        }
      }

      assert.equal(stack.length, 0, `${def.type} 的 guide 里有没闭合的标签：${stack.join(', ')}`);
    }
  });

  test('★ 引导里只用设置页样式表覆盖到的元素', () => {
    // 用没写样式的标签不会报错，只会默默显示成一坨没有排版的文字
    const styled = new Set([
      'ol', 'ul', 'li', 'p', 'strong', 'em', 'code', 'details', 'summary',
      'br', 'a', 'span',
    ]);
    for (const def of channelCatalog()) {
      if (!def.guide) continue;
      for (const m of def.guide.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b/g)) {
        const tag = m[1].toLowerCase();
        assert.ok(styled.has(tag), `${def.type} 的 guide 用了没有样式的标签 <${tag}>`);
      }
    }
  });
});
