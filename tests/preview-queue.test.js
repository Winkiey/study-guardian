/**
 * 预览生成的并发闸门。
 *
 * 起因：用户报「新上传的课件只能看到文字，以前的能直接看 PPT」。
 * 老课件的 PDF 早就转好躺在缓存里，所以只有新传的受影响 ——
 * 问题出在转换这一步。
 *
 * 其中一条确定的原因：上传接口把转换丢到后台就立刻返回，
 * 浏览器接着传下一个文件，于是「一次选 5 个课件」= 5 个 LibreOffice
 * 同时起来。每个实例几百 MB，2 核 2G 的服务器上几个就打满内存，
 * 被 OOM 杀掉，转换失败 → 退化成纯文字。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-previewq-test-'));
process.env.DATA_DIR = DATA_DIR;
// 把并发上限压到 1，测试才有确定的预期
process.env.PREVIEW_CONCURRENCY = '1';
process.env.SCHEDULER_RUN_ON_START = 'false';

let auth;
let db;
let materials;
let config;

before(async () => {
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  materials = await import('../src/lib/materials.js');
  config = (await import('../src/config.js')).default;
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let seq = 0;

/** 造一份纯文本课件（它的预览流水线只是读文件，不依赖任何外部程序） */
async function makeTextMaterial(userId) {
  seq += 1;
  return materials.createMaterialFromUpload(
    userId,
    {
      filename: `并发测试${seq}.txt`,
      mime: 'text/plain',
      data: Buffer.from(`第 ${seq} 份测试内容`, 'utf8'),
    },
    { title: `并发测试${seq}` },
  );
}

function makeUser(prefix = 'q') {
  return auth.createUser({
    username: `${prefix}${Math.random().toString(36).slice(2, 8)}`,
    password: 'test123456',
  });
}

describe('并发上限本身', () => {
  test('★ 默认只跑 1 个转换（小内存服务器上这是刻意的选择）', () => {
    assert.equal(config.previewConcurrency, 1,
      '默认值必须是 1：连传几个课件时同时起多个 LibreOffice 会把 2G 的机器打爆。'
      + '要放开请显式设 PREVIEW_CONCURRENCY。');
  });
});

describe('★ 连传多个课件时不会同时起一堆转换', () => {
  test('★ 一次排 3 个，只有 1 个在跑，另外 2 个在排队', async () => {
    const u = makeUser('burst');
    const list = [];
    for (let i = 0; i < 3; i += 1) list.push(await makeTextMaterial(u.id));

    // 连着排（不 await），模拟「浏览器飞快地传了下一个」
    const running = list.map((m) => materials.schedulePreview(m.id));

    const state = materials.previewQueueState();
    assert.equal(state.running, config.previewConcurrency,
      `同时在跑的应该正好是上限 ${config.previewConcurrency} 个，实际 ${state.running}`);
    assert.equal(state.waiting, 3 - config.previewConcurrency,
      `其余应该排队等着，实际排队 ${state.waiting}`);
    assert.equal(state.running + state.waiting, 3,
      '★ 三份课件一份都不能丢，全都要在「在跑 + 排队」里');

    await Promise.all(running);

    assert.deepEqual(materials.previewQueueState(), { running: 0, waiting: 0 },
      '跑完之后队列要清空');

    // 排队不等于失败：三份最后都要生成好
    for (const m of list) {
      const row = db.get('SELECT preview_status FROM materials WHERE id = ?', m.id);
      assert.equal(row.preview_status, 'ready', `资料 ${m.id} 应该生成完成`);
    }
  });

  test('★ 跑完一个立刻补上下一个，但补的时候也不越过上限', async () => {
    const u = makeUser('refill');
    const list = [];
    for (let i = 0; i < 3; i += 1) list.push(await makeTextMaterial(u.id));

    const promises = list.map((m) => materials.buildPreview(m.id));

    assert.equal(materials.previewQueueState().running, 1);
    assert.equal(materials.previewQueueState().waiting, 2);

    await promises[0];
    const mid = materials.previewQueueState();
    assert.equal(mid.running, 1, '★ 空出来的槽要立刻被下一个补上，不能空转');
    assert.equal(mid.waiting, 1);

    await Promise.all(promises);
    assert.deepEqual(materials.previewQueueState(), { running: 0, waiting: 0 });
  });

  test('★ 排队是先进先出：先排的先生成', async () => {
    const u = makeUser('fifo');
    const list = [];
    for (let i = 0; i < 4; i += 1) list.push(await makeTextMaterial(u.id));

    const order = [];
    await Promise.all(list.map((m) => materials.buildPreview(m.id).then(() => order.push(m.id))));

    assert.deepEqual(order, list.map((m) => m.id), '应该严格按排队顺序完成');
  });

  test('一份转换出错不会把队列卡死，后面的照样跑', async () => {
    const u = makeUser('boom');

    // 造一份「原件不在磁盘上」的课件：预览必定失败。
    // stored_name 存的是带年月子目录的相对路径，直接拼 uploads 即可。
    const broken = await makeTextMaterial(u.id);
    fs.rmSync(path.join(config.uploadDir, broken.stored_name), { force: true });

    const good1 = await makeTextMaterial(u.id);
    const good2 = await makeTextMaterial(u.id);

    await Promise.all([broken, good1, good2].map((m) => materials.schedulePreview(m.id)));

    assert.equal(db.get('SELECT preview_status FROM materials WHERE id = ?', broken.id).preview_status,
      'failed', '坏的那份应该被标成失败');
    for (const m of [good1, good2]) {
      assert.equal(db.get('SELECT preview_status FROM materials WHERE id = ?', m.id).preview_status,
        'ready', `好资料 ${m.id} 不该被坏资料连累`);
    }
    assert.deepEqual(materials.previewQueueState(), { running: 0, waiting: 0 },
      '★ 出过错之后队列也必须清空，否则整个预览功能会永久停摆');
  });
});

describe('★ 服务重启后卡住的课件要能自愈', () => {
  test('★ pendingPreviewMaterials 只报「等待生成」的', async () => {
    const u = makeUser('stuck');

    const done = await makeTextMaterial(u.id);
    await materials.buildPreview(done.id); // 让它变成 ready

    const stuck = await makeTextMaterial(u.id); // 留着 pending，模拟转换途中进程被杀

    const ids = materials.pendingPreviewMaterials();
    assert.ok(ids.includes(stuck.id), '卡住的那份应该被找出来');
    assert.ok(!ids.includes(done.id), '已经生成好的不该被重新排队');
  });

  test('★ 把卡住的重新排一遍就能恢复（这就是启动时做的事）', async () => {
    const u = makeUser('heal');
    const stuck = await makeTextMaterial(u.id);

    assert.equal(db.get('SELECT preview_status FROM materials WHERE id = ?', stuck.id).preview_status,
      'pending');

    // server.js 启动时做的就是这两步
    for (const id of materials.pendingPreviewMaterials()) materials.schedulePreview(id);
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(db.get('SELECT preview_status FROM materials WHERE id = ?', stuck.id).preview_status,
      'ready', '重新排队之后应该自愈');
  });
});

describe('静态守卫', () => {
  test('★ 上传接口必须走排队的那条路，不能直接调 buildPreview', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/routes/api.js'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    assert.match(src, /schedulePreview\(/, '上传接口应该用 schedulePreview');
    assert.ok(!/\bbuildPreview\(/.test(src),
      '不要直接调 buildPreview —— 那样绕过了并发闸门，连传几个课件就能把机器打爆');
  });

  test('★ server.js 启动时要重排卡住的预览', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../server.js'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    assert.match(src, /pendingPreviewMaterials\(\)/, '启动时要扫一遍未完成的预览');
    assert.match(src, /schedulePreview\(/, '扫到之后要重新排队');
  });
});

// ============================================================
// 「重新转换」必须真的重转
//
// 这一段来自真事：用户装完中文字体后点「重新转换」，看到的还是那份乱码 PDF，
// 于是以为「装字体没用」。真实原因是 convertToPdf 有一条复用逻辑 ——
// 同名 PDF 已存在就直接返回它 —— 而 rebuildPreview 只删了幻灯片图片，
// **没删 PDF**，所以「重新转换」原样返回了上一次的文件。
// ============================================================

describe('★ 「重新转换」必须真的重转，而不是复用旧产物', () => {
  test('★ pdfOutputPathFor 指向缓存目录，由原件主名派生', async () => {
    const convert = await import('../src/lib/convert.js');
    const p = convert.pdfOutputPathFor(path.join(config.uploadDir, '2026/09/abc123.pptx'));
    assert.ok(p.startsWith(path.join(config.cacheDir, 'pdf')), `应该落在 cache/pdf 下：${p}`);
    assert.ok(p.endsWith('abc123.pdf'), `应该用原件主名：${p}`);
  });

  test('★ discardConvertedPdf 能删掉旧 PDF，文件本来不在也不报错', async () => {
    const convert = await import('../src/lib/convert.js');
    const input = path.join(config.uploadDir, '2026/09/discard-me-1.pptx');
    const target = convert.pdfOutputPathFor(input);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old pdf');

    assert.equal(await convert.discardConvertedPdf(input), true, '应该报告删掉了');
    assert.equal(fs.existsSync(target), false, '文件应该真的没了');
    assert.equal(await convert.discardConvertedPdf(input), false, '再删一次返回 false，但不抛错');
  });

  test('★ 重新转换之前，上一次的 PDF 必须被清掉（否则会原样复用）', async () => {
    const convert = await import('../src/lib/convert.js');
    const u = makeUser('rebuild');

    // 造一份 Office 课件（用 docx：进度不会走到「导出幻灯片图片」那条 Windows 专用路径）
    const m = await materials.createMaterialFromUpload(
      u.id,
      { filename: `重转测试${seq += 1}.docx`, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: Buffer.from('dummy') },
      { title: '重转测试' },
    );

    // 假装上一次已经转好了一份 PDF
    const storedAbs = path.join(config.uploadDir, m.stored_name);
    const oldPdf = convert.pdfOutputPathFor(storedAbs);
    fs.mkdirSync(path.dirname(oldPdf), { recursive: true });
    fs.writeFileSync(oldPdf, 'OLD-PDF-CONTENT');
    db.run("UPDATE materials SET pdf_name = '../cache/pdf/x.pdf', preview_status = 'ready' WHERE id = ?", m.id);

    // 关掉转换：这样「重转」一定失败，正好用来观察旧产物有没有被清
    const saved = config.enableOfficeConvert;
    config.enableOfficeConvert = false;
    try {
      await materials.rebuildPreview(u.id, m.id);
    } finally {
      config.enableOfficeConvert = saved;
    }

    assert.equal(fs.existsSync(oldPdf), false,
      '★ 旧的 PDF 必须被删掉。留着它的话 convertToPdf 会直接复用，'
      + '「重新转换」就成了摆设：界面报成功、内容一个字没变');

    const row = db.get('SELECT pdf_name FROM materials WHERE id = ?', m.id);
    assert.equal(row.pdf_name, '', '数据库里的 pdf_name 也要清掉');
  });
});
