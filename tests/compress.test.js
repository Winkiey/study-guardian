/**
 * gzip 压缩的单元测试。
 *
 * 压缩这个功能最危险的失败方式不是「没压」，而是**「说压了但没压」**：
 * 响应头写着 Content-Encoding: gzip，正文却是原文 ——
 * 浏览器会拿 gzip 解压器去解一堆 HTML，用户看到的就是一片乱码。
 * 所以这里的重点全在「声明与实际必须一致」上。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  acceptsGzip,
  applyCompressionHeaders,
  attachGzip,
  gzipFile,
  gzipQuality,
  isCompressibleType,
  resetCompressCache,
  shouldCompress,
} from '../src/lib/compress.js';

/** 造一个够小的假 req */
const reqWith = (acceptEncoding, method = 'GET') => ({
  method,
  headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
});

/** 造一个记录调用的假 res */
function fakeRes() {
  return {
    headCalls: [],
    writeCalls: [],
    endCalls: [],
    removedHeaders: [],
    writeHead(status, ...rest) {
      this.headCalls.push([status, ...rest]);
      return this;
    },
    write(...args) { this.writeCalls.push(args); },
    end(...args) { this.endCalls.push(args); },
    removeHeader(name) { this.removedHeaders.push(name); },
  };
}

/** 取最后写出去的头对象 */
function lastHeaders(res) {
  const call = res.headCalls[res.headCalls.length - 1];
  return call[call.length - 1];
}

describe('Accept-Encoding 的解析', () => {
  test('常见的几种写法', () => {
    assert.ok(gzipQuality('gzip') > 0);
    assert.ok(gzipQuality('deflate, gzip') > 0);
    assert.ok(gzipQuality('gzip, deflate, br') > 0);
    assert.ok(gzipQuality('GZIP') > 0, '大小写不敏感');
    assert.ok(gzipQuality('*') > 0, '通配符表示都接受');
    assert.ok(gzipQuality('gzip;q=0.5') > 0);
  });

  test('★ gzip;q=0 表示明确拒绝，不能因为出现了 gzip 字样就压', () => {
    assert.equal(gzipQuality('gzip;q=0'), 0);
    assert.equal(gzipQuality('deflate, gzip;q=0'), 0);
    assert.equal(gzipQuality('gzip;q=0.000'), 0);
  });

  test('不支持 gzip 的情况', () => {
    assert.equal(gzipQuality(''), 0);
    assert.equal(gzipQuality(undefined), 0);
    assert.equal(gzipQuality('deflate, br'), 0);
    assert.equal(gzipQuality('identity'), 0);
  });

  test('acceptsGzip 就是质量值大于 0', () => {
    assert.equal(acceptsGzip(reqWith('gzip')), true);
    assert.equal(acceptsGzip(reqWith('gzip;q=0')), false);
    assert.equal(acceptsGzip(reqWith(undefined)), false);
  });
});

describe('哪些类型值得压', () => {
  test('文本类都压', () => {
    for (const t of [
      'text/html; charset=utf-8',
      'text/css; charset=utf-8',
      'text/javascript; charset=utf-8',
      'application/json; charset=utf-8',
      'application/javascript',
      'application/manifest+json; charset=utf-8',
      'application/xml',
      'image/svg+xml',
    ]) {
      assert.equal(isCompressibleType(t), true, `${t} 应该压`);
    }
  });

  test('★ 本身就是压缩格式的不压（压了白费 CPU，体积几乎不变）', () => {
    for (const t of [
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'application/pdf', 'application/zip',
      'video/mp4', 'audio/mpeg',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]) {
      assert.equal(isCompressibleType(t), false, `${t} 不该压`);
    }
  });

  test('没有 Content-Type 时不压（不知道是什么，别乱动）', () => {
    assert.equal(isCompressibleType(''), false);
    assert.equal(isCompressibleType(undefined), false);
  });
});

describe('该不该压这块正文', () => {
  const html = { 'Content-Type': 'text/html; charset=utf-8' };
  const big = Buffer.alloc(4096, 'a');

  test('正常情况压', () => {
    assert.equal(shouldCompress({ status: 200, headers: html }, big), true);
  });

  test('★ 太小不压（gzip 头尾有开销，小正文可能反而变大）', () => {
    assert.equal(shouldCompress({ status: 200, headers: html }, Buffer.from('hi')), false);
  });

  test('★ 204 / 304 / 206 都不压', () => {
    assert.equal(shouldCompress({ status: 204, headers: html }, big), false, '204 没有正文');
    assert.equal(shouldCompress({ status: 304, headers: html }, big), false, '304 没有正文');
    // 206 是 Range 分片，压了会把 Content-Range 的语义搞乱（音视频拖动进度条要用）
    assert.equal(shouldCompress({ status: 206, headers: html }, big), false);
  });

  test('★ 已经压过的不再叠一层', () => {
    assert.equal(shouldCompress({
      status: 200,
      headers: { ...html, 'Content-Encoding': 'gzip' },
    }, big), false);
  });

  test('没有正文时不压', () => {
    assert.equal(shouldCompress({ status: 200, headers: html }, null), false);
    assert.equal(shouldCompress({ status: 200, headers: html }, Buffer.alloc(0)), false);
  });
});

describe('压缩后的响应头', () => {
  test('★ Content-Length 必须改成压缩后的长度', () => {
    const headers = { 'Content-Type': 'text/html', 'Content-Length': 10000 };
    applyCompressionHeaders(headers, 1234);
    assert.equal(headers['Content-Length'], 1234);
  });

  test('★ 必须带 Vary: Accept-Encoding', () => {
    // 少了它，中间缓存会把 gzip 版本发给不支持 gzip 的客户端 —— 对方拿到乱码
    const headers = {};
    applyCompressionHeaders(headers, 10);
    assert.equal(headers.Vary, 'Accept-Encoding');
    assert.equal(headers['Content-Encoding'], 'gzip');
  });

  test('已有的 Vary 会被合并而不是覆盖', () => {
    const headers = { Vary: 'Cookie' };
    applyCompressionHeaders(headers, 10);
    assert.equal(headers.Vary, 'Cookie, Accept-Encoding');
  });

  test('Vary 里已经有 Accept-Encoding 时不重复添加', () => {
    const headers = { Vary: 'Accept-Encoding' };
    applyCompressionHeaders(headers, 10);
    assert.equal(headers.Vary, 'Accept-Encoding');
  });
});

describe('attachGzip：包在响应上的自动压缩', () => {
  const longHtml = `<html><body>${'内容'.repeat(2000)}</body></html>`;

  test('客户端不支持 gzip 时根本不装（零开销）', () => {
    const res = fakeRes();
    assert.equal(attachGzip(reqWith('identity'), res), false);
  });

  test('★ 压缩后：声明与实际字节必须一致，且能解压回原文', () => {
    const res = fakeRes();
    attachGzip(reqWith('gzip'), res);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(longHtml);

    const sent = res.endCalls[0][0];
    const headers = lastHeaders(res);

    assert.equal(headers['Content-Encoding'], 'gzip', '应该声明 gzip');
    assert.equal(headers['Content-Length'], sent.length,
      '★ Content-Length 必须等于实际发出去的字节数，否则浏览器会截断或卡住');
    assert.equal(
      zlib.gunzipSync(sent).toString('utf8'),
      longHtml,
      '★ 解压回来必须一字不差',
    );
    assert.equal(headers.Vary, 'Accept-Encoding');
  });

  test('★ 很短的正文不压，原样放行', () => {
    const res = fakeRes();
    attachGzip(reqWith('gzip'), res);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('太短了');

    assert.equal(res.endCalls[0][0], '太短了', '应该原样发出去');
    assert.equal(lastHeaders(res)['Content-Encoding'], undefined);
  });

  test('★ 图片这类已经是压缩格式的不压', () => {
    const res = fakeRes();
    attachGzip(reqWith('gzip'), res);
    const png = Buffer.alloc(5000, 7);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);

    assert.equal(res.endCalls[0][0], png);
    assert.equal(lastHeaders(res)['Content-Encoding'], undefined);
  });

  test('HTTP 状态码和状态文本会被原样保留', () => {
    const res = fakeRes();
    attachGzip(reqWith('gzip'), res);
    res.writeHead(404, 'Not Found', { 'Content-Type': 'text/html' });
    res.end(longHtml);

    assert.equal(res.headCalls[0][0], 404);
    assert.equal(res.headCalls[0][1], 'Not Found');
  });

  test('writeHead(status, headers) 两参数写法也认', () => {
    const res = fakeRes();
    attachGzip(reqWith('gzip'), res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ msg: '内容'.repeat(2000) }));

    assert.equal(lastHeaders(res)['Content-Encoding'], 'gzip');
  });

  test('★ 流式响应（先 write 再 end）彻底放行，不碰', () => {
    // sendFile / serveStatic 那种边读边发的响应，长度事先不知道，不能在 end 时压
    const res = fakeRes();
    attachGzip(reqWith('gzip'), res);
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.write(Buffer.from('chunk-1'));
    res.write(Buffer.from('chunk-2'));
    res.end();

    assert.equal(res.writeCalls.length, 2, '两次 write 应该原样穿过去');
    assert.equal(lastHeaders(res)['Content-Encoding'], undefined);
    assert.equal(res.headCalls.length, 1, '头只发一次');
  });

  test('★ 204 无正文的响应不会被加上 gzip 头', () => {
    const res = fakeRes();
    attachGzip(reqWith('gzip'), res);
    res.writeHead(204, {});
    res.end();

    assert.equal(lastHeaders(res)['Content-Encoding'], undefined);
  });

  test('HEAD 请求不装压缩（本来就没有正文）', () => {
    const res = fakeRes();
    assert.equal(attachGzip(reqWith('gzip', 'HEAD'), res), false);
  });

  test('res.end(callback) 这种只有回调的写法不会崩', () => {
    const res = fakeRes();
    attachGzip(reqWith('gzip'), res);
    res.writeHead(302, { Location: '/login' });
    assert.doesNotThrow(() => res.end(() => {}));
  });
});

describe('文件级 gzip 缓存', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-gz-'));
  const file = path.join(dir, 'a.txt');

  before(() => { resetCompressCache(); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('压出来的内容解压后与原文一致', async () => {
    const text = '压缩测试内容'.repeat(500);
    fs.writeFileSync(file, text, 'utf8');
    const gz = await gzipFile(file, fs.statSync(file));
    assert.equal(zlib.gunzipSync(gz).toString('utf8'), text);
    assert.ok(gz.length < Buffer.byteLength(text), '应该确实变小了');
  });

  test('★ 文件改了之后缓存会失效（不会一直发旧内容）', async () => {
    const text = '新的内容'.repeat(500);
    fs.writeFileSync(file, text, 'utf8');
    // 等一毫秒确保 mtime 变了
    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(file, `${text}!`, 'utf8');

    const gz = await gzipFile(file, fs.statSync(file));
    assert.equal(zlib.gunzipSync(gz).toString('utf8'), `${text}!`,
      '文件改了必须重新压，否则用户看到的是旧内容');
  });
});
