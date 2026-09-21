/**
 * 从 PDF 里抽内嵌位图。
 *
 * ⚠️ fixture 全部是**合成**的（下面自己拼一个最小 PDF），
 *    绝不能用那份真实的课表 PDF —— 它的文字层里带着姓名和学号，
 *    而仓库是公开的。真实的文件只用来做本地人工验收。
 *
 * 这一组测试要守住的是两类东西：
 *   1. **正面能力**：Flate 的 RGB / 灰度、带行预测器的、JPEG 直通，
 *      都要能正确还原成一张图（并且像素值确实对得上，不是「没报错就算过」）。
 *   2. **安全边界**：魔数、体积、页数、加密、zip bomb、超宽高 —— 
 *      这些每一条都是「不做就会被滥用」的，不是可选项。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const { extractTimetableImage, DEFAULT_LIMITS } = await import('../src/lib/import/pdf-image.js');
const { encodePng, undoPngPredictor } = await import('../src/lib/png.js');

// ============================================================
// 合成一个最小 PDF
// ============================================================

/**
 * 拼一份最小可用的 PDF。
 *
 * 只需要让我自己的扫描器认出来即可 —— 扫描器找的是
 * `<< … /Subtype /Image … >> stream … endstream`，所以这里把对象
 * 按真实 PDF 的样子写出来，但省略交叉引用表（解析器不依赖它）。
 */
function makePdf({
  images = [],
  extraPages = 0,
  encrypt = false,
  trailerExtra = '',
} = {}) {
  const parts = ['%PDF-1.3\n'];
  // 真实 PDF 的加密标记是 trailer 里的 `/Encrypt N 0 R`
  if (encrypt) parts.push('1 0 obj\n<< /Filter /Standard /V 2 /R 3 >>\nendobj\n');
  for (const img of images) {
    parts.push(`${img.obj ?? 3} 0 obj\n<< ${img.dict} >>\nstream\n`);
    parts.push(img.stream.toString('latin1'));
    parts.push('\nendstream\nendobj\n');
  }
  // 页面对象：countPages 靠 `/Type /Page`（后面不跟 s）来数
  parts.push('5 0 obj\n<< /Type /Page /MediaBox [0 0 595 842] >>\nendobj\n');
  for (let i = 0; i < extraPages; i += 1) {
    parts.push(`${10 + i} 0 obj\n<< /Type /Page /MediaBox [0 0 595 842] >>\nendobj\n`);
  }
  parts.push(encrypt ? 'trailer\n<< /Size 6 /Encrypt 1 0 R >>\n' : 'trailer\n<< /Size 6 >>\n');
  parts.push(trailerExtra);
  parts.push('%%EOF\n');
  return Buffer.from(parts.join(''), 'latin1');
}

/** 造一张 RGB / 灰度的 Flate 位图对象 */
function flateImage({ width, height, channels, data, predictor = 0, extraDict = '' }) {
  const cs = channels === 1 ? 'DeviceGray' : 'DeviceRGB';
  const pred = predictor >= 10 ? ` /DecodeParms << /Predictor ${predictor} /Colors ${channels} /Columns ${width} >>` : '';
  return {
    dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height}`
      + ` /ColorSpace /${cs} /BitsPerComponent 8 /Filter /FlateDecode${pred}${extraDict}`,
    stream: zlib.deflateSync(data),
  };
}

/** 把 PNG 的像素读回来，用于「值确实对得上」的断言 */
function readPngPixels(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25];
  const channels = colorType === 0 ? 1 : (colorType === 2 ? 3 : 4);
  // 找 IDAT
  let at = 8;
  const idat = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, 'PNG 每行的 filter 字节应该是 0');
    raw.copy(out, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, channels, pixels: out };
}

/** 造一块有规律但不单调的像素，方便验「位置没串」 */
function pattern(width, height, channels) {
  const out = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        out[(y * width + x) * channels + c] = (x * 37 + y * 11 + c * 91) & 0xff;
      }
    }
  }
  return out;
}

// ============================================================
// 正面能力
// ============================================================

describe('★ 能把 PDF 里的课表图抽出来', () => {
  test('★ RGB 位图：抽出来是 PNG，而且像素一个不差', () => {
    const w = 9; const h = 5;
    const pixels = pattern(w, h, 3);
    const pdf = makePdf({ images: [flateImage({ width: w, height: h, channels: 3, data: pixels })] });

    const img = extractTimetableImage(pdf);
    assert.equal(img.mime, 'image/png');
    assert.equal(img.width, w);
    assert.equal(img.height, h);

    // 关键：不是"没报错就算过" —— 把像素读回来逐个比。
    // 通道顺序或行顺序搞错的话，图会看起来「差不多但不对」，肉眼很难发现。
    const back = readPngPixels(img.data);
    assert.equal(back.channels, 3);
    assert.deepEqual(back.pixels, pixels, '像素值对不上 —— 通道或行序错了');
  });

  test('灰度位图也能抽（软遮罩那种）', () => {
    const w = 4; const h = 3;
    const pixels = pattern(w, h, 1);
    const pdf = makePdf({ images: [flateImage({ width: w, height: h, channels: 1, data: pixels })] });
    const img = extractTimetableImage(pdf);
    assert.equal(readPngPixels(img.data).channels, 1);
    assert.deepEqual(readPngPixels(img.data).pixels, pixels);
  });

  test('★ 两张同尺寸的图：选大的那张，不选软遮罩', () => {
    // 真实课表就是这个结构：课表图 3366×1850（278KB）+ 灰度软遮罩 3366×1850（6KB）。
    // 按像素面积挑会平局 → 可能拿到那张全灰的遮罩，用户看到的是一片灰。
    const w = 6; const h = 4;
    const content = pattern(w, h, 3);
    const mask = Buffer.alloc(w * h, 0);
    const pdf = makePdf({
      images: [
        { ...flateImage({ width: w, height: h, channels: 1, data: mask }), obj: 3 },
        { ...flateImage({ width: w, height: h, channels: 3, data: content }), obj: 4 },
      ],
    });
    const img = extractTimetableImage(pdf);
    assert.equal(img.width, w);
    assert.equal(img.height, h);
    assert.deepEqual(readPngPixels(img.data).pixels, content,
      '★ 拿到的是遮罩（全灰）而不是课表 —— 挑图规则错了');
  });

  test('JPEG 位图原样直通，不重新编码（省一次有损压缩）', () => {
    // 一个最小的 JPEG 头（FFD8FF）+ 随便一点数据
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    const pdf = makePdf({
      images: [{
        dict: '/Type /XObject /Subtype /Image /Width 100 /Height 80 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
        stream: jpeg,
      }],
    });
    const img = extractTimetableImage(pdf);
    assert.equal(img.mime, 'image/jpeg');
    assert.equal(img.kind, 'jpeg');
    assert.deepEqual(img.data, jpeg, 'JPEG 应该原样透传');
  });

  test('带行预测器（Predictor）的图解出来也对', () => {
    // 手工造一份带 Sub 预测器（filter=1）的数据，看能不能还原回原像素
    const w = 5; const h = 3; const channels = 3;
    const original = pattern(w, h, channels);
    const stride = w * channels;
    const encoded = Buffer.alloc((stride + 1) * h);
    for (let y = 0; y < h; y += 1) {
      encoded[y * (stride + 1)] = 1;   // Sub
      for (let x = 0; x < stride; x += 1) {
        const left = x >= channels ? original[y * stride + x - channels] : 0;
        encoded[y * (stride + 1) + 1 + x] = (original[y * stride + x] - left) & 0xff;
      }
    }
    // 自己先验一遍还原函数（它是这条链上最容易写错的一段）
    assert.deepEqual(undoPngPredictor(encoded, w, h, channels), original);

    const pdf = makePdf({
      images: [flateImage({ width: w, height: h, channels, data: encoded, predictor: 12 })],
    });
    assert.deepEqual(readPngPixels(extractTimetableImage(pdf).data).pixels, original);
  });

  test('一份 PDF 里有多张图时，挑最大的那张', () => {
    const small = pattern(3, 2, 3);
    const big = pattern(20, 12, 3);
    const pdf = makePdf({
      images: [
        { ...flateImage({ width: 3, height: 2, channels: 3, data: small }), obj: 3 },
        { ...flateImage({ width: 20, height: 12, channels: 3, data: big }), obj: 4 },
      ],
    });
    const img = extractTimetableImage(pdf);
    assert.equal(img.width, 20);
  });
});

// ============================================================
// 安全边界
// ============================================================

describe('★ 安全边界（每一条不做都会被滥用）', () => {
  test('★ 不是 PDF 就说不是 PDF（扩展名不算数）', () => {
    assert.throws(
      () => extractTimetableImage(Buffer.from('PK\u0003\u0004 这是一个 docx，只是被改名成 .pdf')),
      /不是 PDF/,
    );
  });

  test('空文件也不崩，给一句人话', () => {
    assert.throws(() => extractTimetableImage(Buffer.alloc(0)), /没有收到文件内容/);
  });

  test('★ 超大的 PDF 被挡住', () => {
    const big = Buffer.concat([
      Buffer.from('%PDF-1.3\n'),
      Buffer.alloc(DEFAULT_LIMITS.maxBytes + 100, 0x20),
    ]);
    assert.throws(() => extractTimetableImage(big), /太大了/);
  });

  test('★ 解压炸弹挡得住（几百字节的流想解出几个 GB）', () => {
    // 一千万个 0 压出来只有十几 KB，但解开是 10MB。
    // 把上限压到 1MB，它必须被挡住 —— 而不是把进程撑死。
    const bomb = zlib.deflateSync(Buffer.alloc(10 * 1024 * 1024, 0));
    const pdf = makePdf({
      images: [{
        dict: '/Type /XObject /Subtype /Image /Width 2000 /Height 2000'
          + ' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
        stream: bomb,
      }],
    });
    assert.ok(bomb.length < 100 * 1024, '前提：炸弹本身应该很小');
    assert.throws(
      () => extractTimetableImage(pdf, { maxInflated: 1024 * 1024 }),
      /解压后超过安全上限/,
    );
  });

  test('★ 页数太多被挡住（只处理课表那一页）', () => {
    const pdf = makePdf({
      images: [flateImage({ width: 4, height: 4, channels: 3, data: pattern(4, 4, 3) })],
      extraPages: 5,
    });
    assert.throws(() => extractTimetableImage(pdf), /超过上限.*页/);
  });

  test('加密的 PDF 明确说加密，而不是"读不出图片"', () => {
    const pdf = makePdf({ encrypt: true });
    assert.throws(() => extractTimetableImage(pdf), /加了密码/);
  });

  test('★ 像素数离谱的被挡住（宽高是 PDF 自己写的，可以瞎写）', () => {
    const pdf = makePdf({
      images: [{
        dict: '/Type /XObject /Subtype /Image /Width 60000 /Height 60000'
          + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode',
        stream: zlib.deflateSync(Buffer.alloc(100)),
      }],
    });
    assert.throws(() => extractTimetableImage(pdf), /图太大|没能从这份 PDF/);
  });

  test('★ 没有图片时说清楚，并指一条别的路（不能返回全黑图）', () => {
    const pdf = makePdf({});
    assert.throws(
      () => extractTimetableImage(pdf),
      (err) => /没有内嵌图片/.test(err.message) && /粘贴表格内容|手动添加/.test(err.message),
    );
  });

  test('不支持的压缩方式时，说清是哪种，并给出替代方案', () => {
    const pdf = makePdf({
      images: [{
        dict: '/Type /XObject /Subtype /Image /Width 10 /Height 10'
          + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode',
        stream: Buffer.alloc(50),
      }],
    });
    assert.throws(
      () => extractTimetableImage(pdf),
      (err) => /不支持的压缩方式/.test(err.message) && /JPXDecode/.test(err.message),
    );
  });

  test('位深不是 8 的图不硬解（解出来会是花屏）', () => {
    const pdf = makePdf({
      images: [{
        dict: '/Type /XObject /Subtype /Image /Width 8 /Height 8'
          + ' /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode',
        stream: zlib.deflateSync(Buffer.alloc(8)),
      }],
    });
    assert.throws(() => extractTimetableImage(pdf), /位深/);
  });

  test('像素数据不完整时拒掉，而不是画出一张歪图', () => {
    const w = 10; const h = 10;
    const pdf = makePdf({
      images: [flateImage({ width: w, height: h, channels: 3, data: Buffer.alloc(w * h * 3 - 50, 0) })],
    });
    assert.throws(() => extractTimetableImage(pdf), /不完整|没能从这份 PDF/);
  });

  test('损坏的 Flate 流不崩，给一句人话', () => {
    const pdf = makePdf({
      images: [{
        dict: '/Type /XObject /Subtype /Image /Width 4 /Height 4'
          + ' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
        stream: Buffer.from('这不是压缩数据不是压缩数据'),
      }],
    });
    assert.throws(() => extractTimetableImage(pdf), /解不开|没能从这份 PDF/);
  });
});

// ============================================================
// PNG 编码器本身
// ============================================================

describe('★ PNG 编码器', () => {
  test('像素长度不对要当场报错（否则图会越往下越歪）', () => {
    assert.throws(
      () => encodePng({ width: 4, height: 4, channels: 3, data: Buffer.alloc(10) }),
      /长度不对/,
    );
  });

  test('尺寸 / 通道数不合法也报错', () => {
    assert.throws(() => encodePng({ width: 0, height: 4, channels: 3, data: Buffer.alloc(0) }), /尺寸不合法/);
    assert.throws(() => encodePng({ width: 4, height: 4, channels: 2, data: Buffer.alloc(32) }), /通道数/);
  });

  test('产出的确实是 PNG（签名 + IHDR + IDAT + IEND 齐全）', () => {
    const png = encodePng({ width: 2, height: 2, channels: 3, data: pattern(2, 2, 3) });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const text = png.toString('latin1');
    assert.ok(text.includes('IHDR') && text.includes('IDAT') && text.includes('IEND'));
    assert.equal(readPngPixels(png).width, 2);
  });

  test('行预测器的长度不足时报错，而不是悄悄画错', () => {
    assert.throws(() => undoPngPredictor(Buffer.alloc(5), 10, 10, 3), /长度不足/);
  });

  test('不认识的过滤器值报错（不要当成 None 静默放过）', () => {
    // 宽 3、通道 3 → 每行 9 字节 + 1 个 filter 字节；高 2 → 共 20 字节。
    // （第一版这里按 3*2+1 算，长度不够，结果报的是"长度不足"而不是
    //   "不认识的过滤器" —— 断言和被测行为对不上，等于没测。）
    const bad = Buffer.alloc((3 * 3 + 1) * 2);
    bad[0] = 9;   // 9 不是合法过滤器
    assert.throws(() => undoPngPredictor(bad, 3, 2, 3), /不认识的 PNG 行过滤器/);
  });
});
