/**
 * src/lib/zip.js 的单元测试
 *
 * 用测试自带的「最小 zip 打包器」（tests/_zipfixture.js）造出 zip，
 * 再解回来验证往返；覆盖 stored / deflate / 前置数据 / 注释 / ZIP64 /
 * 编码 / CRC32 / 各种损坏与异常声明。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readZip, unzip, crc32, normalizeZipPath } from '../src/lib/zip.js';
import { buildZip, crc32 as crc32Ref } from './_zipfixture.js';

/** 定位中央目录条目在文件中的偏移（用于构造损坏样本） */
function findCentralOffset(buffer) {
  return buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
}

test('crc32 与标准测试向量一致', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('学习守护平台')), crc32Ref(Buffer.from('学习守护平台')));
});

test('stored（method 0）条目可以正常往返，含中文名与目录项', () => {
  const buffer = buildZip([
    { name: 'a.txt', data: 'hello world' },
    { name: 'dir/', dir: true },
    { name: 'dir/中文讲义.txt', data: '课件内容 ABC' },
  ]);
  const zip = readZip(buffer);

  assert.deepEqual(zip.list(), ['a.txt', 'dir/', 'dir/中文讲义.txt']);
  assert.equal(zip.readText('a.txt'), 'hello world');
  assert.equal(zip.readText('dir/中文讲义.txt'), '课件内容 ABC');
  assert.equal(zip.has('a.txt'), true);
  assert.equal(zip.has('nope.txt'), false);

  const entry = zip.entries.get('a.txt');
  assert.equal(entry.method, 0);
  assert.equal(entry.size, 11);
  assert.equal(entry.compressedSize, 11);
  assert.equal(entry.crc32, crc32Ref(Buffer.from('hello world')));
  assert.equal(entry.isDirectory, false);
  assert.equal(zip.entries.get('dir/').isDirectory, true);
  assert.equal(zip.read('dir/').length, 0);

  assert.throws(() => zip.read('missing.txt'), /不存在条目/);
});

test('deflate（method 8）条目可以正常解压', () => {
  const text = '每个学生都要整理错题本。'.repeat(60);
  const buffer = buildZip([{ name: 'long.txt', data: text, method: 'deflate' }]);
  const zip = readZip(buffer);

  const entry = zip.entries.get('long.txt');
  assert.equal(entry.method, 8);
  assert.ok(entry.compressedSize < entry.size, '压缩后应当更小');
  assert.equal(zip.readText('long.txt'), text);
  assert.equal(entry.size, Buffer.byteLength(text, 'utf8'));
});

test('目录版 deflate：混合条目 + unzip 跳过目录项', () => {
  const buffer = buildZip([
    { name: 'ppt/', dir: true },
    { name: 'ppt/slides/slide1.xml', data: '<xml>1</xml>', method: 'deflate' },
    { name: 'ppt/slides/slide2.xml', data: '<xml>2</xml>' },
    { name: 'empty.txt', data: '' },
  ]);
  const zip = readZip(buffer);
  assert.deepEqual(zip.list(), [
    'ppt/',
    'ppt/slides/slide1.xml',
    'ppt/slides/slide2.xml',
    'empty.txt',
  ]);

  const all = unzip(buffer);
  assert.equal(all.has('ppt/'), false, '目录项应被跳过');
  assert.equal(all.size, 3);
  assert.equal(all.get('ppt/slides/slide1.xml').toString('utf8'), '<xml>1</xml>');
  assert.equal(all.get('empty.txt').length, 0);
});

test('zip 前面有其它数据时仍能通过 EOCD 定位', () => {
  const prefix = Buffer.concat([
    Buffer.from('这是一段被拼接在前面的垃圾数据，模拟自解压包或合并文件。'.repeat(5)),
    Buffer.from([0x00, 0xff, 0x50, 0x4b, 0x03, 0x04]),
  ]);
  const buffer = buildZip(
    [
      { name: 'inner.txt', data: 'inside', method: 'deflate' },
      { name: '中文.txt', data: '前置偏移' },
    ],
    { prefix },
  );
  const zip = readZip(buffer);
  assert.equal(zip.readText('inner.txt'), 'inside');
  assert.equal(zip.readText('中文.txt'), '前置偏移');
});

test('EOCD 带注释时仍能正确定位', () => {
  const buffer = buildZip([{ name: 'c.txt', data: 'comment test' }], {
    comment: 'Z'.repeat(300),
  });
  const zip = readZip(buffer);
  assert.equal(zip.readText('c.txt'), 'comment test');
});

test('CRC32 校验失败时抛出中文错误', () => {
  const buffer = buildZip([{ name: 'bad.txt', data: 'payload', crc32: 0xdeadbeef }]);
  assert.throws(
    () => readZip(buffer).read('bad.txt'),
    (err) => err instanceof Error && /CRC32 校验失败/.test(err.message) && /bad\.txt/.test(err.message),
  );
});

test('数据被篡改（CRC 不符）时报错而不是返回垃圾', () => {
  const good = buildZip([{ name: 't.txt', data: 'ABCDEFGH' }]);
  const tampered = Buffer.from(good);
  const at = tampered.indexOf(Buffer.from('ABCDEFGH'));
  assert.ok(at > 0);
  tampered[at + 3] = 0x5a; // 改一个字节
  assert.throws(() => readZip(tampered).read('t.txt'), /CRC32 校验失败/);
});

test('声明的解压大小与实际不符时抛出中文错误', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'abc', size: 999 }]);
  assert.throws(() => readZip(buffer).read('a.txt'), /大小校验失败/);
});

test('声明的压缩大小越界时抛出中文错误', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'abc', compressedSize: 100000 }]);
  assert.throws(() => readZip(buffer).read('a.txt'), /数据越界/);
});

test('不支持的压缩方式抛出中文错误', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'abc', headerMethod: 12 }]);
  assert.throws(() => readZip(buffer).read('a.txt'), /不支持的压缩方式/);
});

test('stored 数据被标成 deflate 时抛解压失败错误', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'not-really-deflate', headerMethod: 8 }]);
  assert.throws(() => readZip(buffer).read('a.txt'), /解压失败/);
});

test('非 zip 数据与过短数据抛出中文错误', () => {
  assert.throws(() => readZip(Buffer.from('这根本不是 zip 文件，只是一段文本')), /不是有效的 ZIP 文件/);
  assert.throws(() => readZip(Buffer.from('PK')), /不是有效的 ZIP 文件/);
  assert.throws(
    () => readZip(Buffer.from(Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256)))),
    /不是有效的 ZIP 文件/,
  );
});

test('文件被截断时抛出中文错误', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'hello', method: 'deflate' }]);
  assert.throws(
    () => readZip(buffer.subarray(0, buffer.length - 4)),
    /不是有效的 ZIP 文件|中央目录|ZIP 结构异常|越界/,
  );
});

test('中央目录签名损坏时抛出中文错误', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'hello' }]);
  const cdAt = findCentralOffset(buffer);
  assert.ok(cdAt > 0);
  buffer.writeUInt32LE(0xdeadbeef, cdAt);
  assert.throws(() => readZip(buffer), /中央目录/);
});

test('中央目录条目字段越界时抛出中文错误', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'hello' }]);
  const cdAt = findCentralOffset(buffer);
  buffer.writeUInt16LE(0xffff, cdAt + 28); // 文件名长度字段被改坏
  assert.throws(() => readZip(buffer), /越界|中央目录/);
});

test('本地文件头签名损坏时抛出中文错误', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'hello' }]);
  buffer.writeUInt32LE(0x11111111, 0);
  assert.throws(() => readZip(buffer).read('a.txt'), /本地文件头签名错误/);
});

test('ZIP64 中央目录（EOCD64 + locator）可以解析', () => {
  const buffer = buildZip(
    [
      { name: 'big.txt', data: 'zip64 content' },
      { name: 'b.txt', data: 'second', method: 'deflate' },
    ],
    { zip64: true },
  );
  const zip = readZip(buffer);
  assert.deepEqual(zip.list(), ['big.txt', 'b.txt']);
  assert.equal(zip.readText('big.txt'), 'zip64 content');
  assert.equal(zip.readText('b.txt'), 'second');
  assert.equal(zip.entries.get('big.txt').zip64, true);
});

test('ZIP64 + 前置数据：locator 中偏移失效时退化为相邻定位', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'zip64 with prefix' }], {
    zip64: true,
    prefix: 'PRE'.repeat(40),
  });
  const zip = readZip(buffer);
  assert.equal(zip.readText('a.txt'), 'zip64 with prefix');
});

test('ZIP64 条目扩展字段可补齐大小与偏移', () => {
  const buffer = buildZip(
    [
      { name: 'a.txt', data: 'zip64 entry A' },
      { name: 'sub/b.txt', data: 'zip64 entry B', method: 'deflate' },
    ],
    { zip64Entries: true },
  );
  const zip = readZip(buffer);
  assert.equal(zip.readText('a.txt'), 'zip64 entry A');
  assert.equal(zip.readText('sub/b.txt'), 'zip64 entry B');
  assert.equal(zip.entries.get('sub/b.txt').zip64, true);
});

test('ZIP64 扩展字段缺失时抛出中文错误', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'abc' }], { zip64Entries: true });
  // 把中央目录条目里的扩展字段长度改成 0，模拟缺少 ZIP64 扩展字段
  const cdAt = findCentralOffset(buffer);
  buffer.writeUInt16LE(0, cdAt + 30);
  buffer.writeUInt16LE(0, cdAt + 32);
  assert.throws(() => readZip(buffer), /ZIP64|越界|中央目录/);
});

test('文件名编码：bit 11 置位的 UTF-8 名、未置位的合法 UTF-8、未置位的 GBK', () => {
  const utf8Flagged = readZip(buildZip([{ name: '课件/第一讲.pptx', data: 'x' }]));
  assert.deepEqual(utf8Flagged.list(), ['课件/第一讲.pptx']);

  // bit 11 未置位但字节是合法 UTF-8（多数现代工具如此）
  const unflagged = readZip(buildZip([{ name: '课件.txt', data: '内容', flags: 0 }]));
  assert.equal(unflagged.readText('课件.txt'), '内容');

  // bit 11 未置位且字节是 GBK（旧版 Windows 压缩工具）
  const gbkName = Buffer.from([0xbf, 0xce, 0xbc, 0xfe, 0x2e, 0x74, 0x78, 0x74]); // 课件.txt
  const gbk = readZip(buildZip([{ name: '课件.txt', nameBytes: gbkName, data: 'GBK 名', flags: 0 }]));
  assert.equal(gbk.readText('课件.txt'), 'GBK 名');
});

test('readText 会去掉 UTF-8 BOM', () => {
  const buffer = buildZip([{ name: 'bom.xml', data: '\uFEFF<root/>' }]);
  assert.equal(readZip(buffer).readText('bom.xml'), '<root/>');
});

test('条目查找容忍开头斜杠、反斜杠与大小写差异', () => {
  const zip = readZip(buildZip([{ name: 'ppt/slides/slide1.xml', data: 'ok' }]));
  assert.equal(zip.has('/ppt/slides/slide1.xml'), true);
  assert.equal(zip.has('ppt\\slides\\slide1.xml'), true);
  assert.equal(zip.has('PPT/SLIDES/SLIDE1.XML'), true);
  assert.equal(zip.readText('/ppt/slides/slide1.xml'), 'ok');
  assert.throws(() => zip.read(''), /非空字符串/);
});

test('写入方用反斜杠当分隔符时（.NET Framework ZipFile）自动规范化', () => {
  const nameBytes = Buffer.from('word\\document.xml', 'utf8');
  const zip = readZip(buildZip([{ name: 'word/document.xml', nameBytes, data: '<w:document/>', flags: 0x800 }]));
  assert.deepEqual(zip.list(), ['word/document.xml']);
  assert.equal(zip.has('word/document.xml'), true);
  assert.equal(zip.readText('word/document.xml'), '<w:document/>');
});

test('normalizeZipPath 处理相对路径与上级目录', () => {
  assert.equal(normalizeZipPath('slides/slide1.xml', 'ppt'), 'ppt/slides/slide1.xml');
  assert.equal(normalizeZipPath('../slides/slide1.xml', 'ppt/notesSlides'), 'ppt/slides/slide1.xml');
  assert.equal(normalizeZipPath('/xl/worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml');
  assert.equal(normalizeZipPath('./a//b/../c.xml', ''), 'a/c.xml');
});

test('流式写入方（本地头大小为 0、数据描述符标记置位）仍能正确读取', () => {
  const text = '流式压缩的内容'.repeat(20);
  const buffer = buildZip([
    { name: 'stream.txt', data: text, method: 'deflate', zeroLocalSizes: true },
    { name: 'plain.txt', data: 'no compression', zeroLocalSizes: true },
  ]);
  const zip = readZip(buffer);
  // 大小与 CRC 一律以中央目录为准，本地头的 0 值被忽略
  assert.equal(zip.entries.get('stream.txt').size, Buffer.byteLength(text, 'utf8'));
  assert.equal(zip.readText('stream.txt'), text);
  assert.equal(zip.readText('plain.txt'), 'no compression');
  assert.equal((zip.entries.get('stream.txt').flags & 0x8) === 0x8, true);
});

test('条目携带无关扩展字段（时间戳等）时不影响定位', () => {
  const buffer = buildZip([
    { name: 'a.txt', data: 'with extra field', extraData: Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]) },
    { name: 'b.txt', data: 'second', method: 'deflate', extraData: Buffer.alloc(9, 0x41) },
  ]);
  const zip = readZip(buffer);
  assert.equal(zip.readText('a.txt'), 'with extra field');
  assert.equal(zip.readText('b.txt'), 'second');
  // 未知扩展字段不应被误当成 ZIP64 字段
  assert.equal(zip.entries.get('a.txt').zip64, false);
});

test('加密（密码保护）条目的错误提示清晰', () => {
  const buffer = buildZip([{ name: 'secret.docx', data: 'x', encrypted: true }]);
  const zip = readZip(buffer);
  assert.equal(zip.entries.get('secret.docx').flags & 0x1, 1);
  assert.throws(() => zip.read('secret.docx'), /已加密.*暂不支持/);
});

test('readZip 拒绝非 Buffer 入参，Uint8Array 可接受', () => {
  assert.throws(() => readZip('/path/to/file.zip'), /Buffer/);
  const buffer = buildZip([{ name: 'a.txt', data: 'u8' }]);
  const zip = readZip(new Uint8Array(buffer));
  assert.equal(zip.readText('a.txt'), 'u8');
});
