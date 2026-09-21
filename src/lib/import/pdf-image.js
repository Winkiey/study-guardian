/**
 * 从 PDF 里抽出内嵌的位图，转成浏览器能直接显示的图片。
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────
 * 教务系统导出的课表 PDF 有两种：
 *   · 文字型：课程内容在文字层里，能直接解析（学校之间差异极大，写不完）；
 *   · **位图型**：整张课表是一张图（我校这份就是，3366×1850）。
 * 位图型没法靠文字解析，OCR 又不可靠（中文课程名错一个字，整学期课表就是错的）。
 * 所以这里换一条路：**把那张原图抽出来给用户自己看** —— 用户读自己的课表
 * 零误差，然后在旁边按格子敲进去。不装任何 OCR，也不依赖版式识别。
 *
 * ── 纯 Node 为什么够用 ──────────────────────────────────────────
 * PDF 里的位图就是「一段 Flate 压缩的裸像素 + 一句描述」，容器格式不难读：
 * 找到 `/Subtype /Image` 的对象字典 → 读出宽高/位深/色彩空间 → inflate → 完事。
 * 不需要 poppler 那一整套。这条链路上唯一需要写的「编码」是把裸像素包成 PNG，
 * 那件事在 src/lib/png.js 里，也是个简单格式。
 *
 * ⚠️ 安全边界（这里每一条都是必须的，不是"最好有"）：
 *   1. **魔数校验**：只看文件开头是不是 `%PDF-`，不信扩展名和 MIME。
 *   2. **输入体积上限**：PDF 会被完整读进内存。
 *   3. **解压体积上限**：Flate 是压缩流，一个几百字节的流可以解出几个 GB
 *      （zip bomb）。所以用 zlib 的 maxOutputLength 硬顶，不能让 inflate
 *      自己决定分配多少内存 —— 那正是内存打满的原因。
 *   4. **像素数上限**：宽高来自 PDF 自己写的数字，可以写到离谱。
 *   5. 解不出来就**明确说原因**，不要返回一张全黑的图 —— 那会让用户以为
 *      「导入成功了，只是看不清」，从而在错误的图上白费功夫。
 */

import zlib from 'node:zlib';
import { encodePng, undoPngPredictor } from '../png.js';

/** 只信文件头。扩展名和 MIME 都是用户能随便写的。 */
const PDF_MAGIC = Buffer.from('%PDF-');

export const DEFAULT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,        // 输入 PDF 上限 10MB
  maxInflated: 80 * 1024 * 1024,     // 单张图解压后上限 80MB（够 3366×1850 的 RGB 用）
  maxPixels: 40 * 1000 * 1000,       // 4000 万像素上限
  maxPages: 3,
};

/** 认得的色彩空间 → 通道数 */
const CHANNELS_BY_COLORSPACE = {
  DeviceGray: 1,
  DeviceRGB: 3,
  DeviceCMYK: 4,
};

/**
 * PDF 里的数字可能是 `123`、`123.0`、`123 0 R`（间接引用）。
 * 间接引用这里解析不了（要追对象表），返回 null 让调用方跳过这张图。
 */
function num(dict, key) {
  const m = new RegExp(`/${key}\\s+([\\d.]+)`).exec(dict);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** 数一下有几页。粗略但够用：只用来拒绝「几百页的 PDF」。 */
function countPages(raw) {
  return (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

/** 去掉流数据末尾那个换行（`endstream` 前的 \n 或 \r\n 不属于数据） */
function trimEol(raw, start, end) {
  let e = end;
  if (e > start && raw[e - 1] === '\n') e -= 1;
  if (e > start && raw[e - 1] === '\r') e -= 1;
  return e;
}

/**
 * 扫出所有内嵌位图。
 *
 * 刻意用「原始字节扫」而不是完整的 PDF 对象解析：目标是取一张图，
 * 为此写一个 PDF 解析器不值得，而且真实世界的 PDF 生成器（pdfmake、
 * Word、WPS、扫描仪）在对象表上的花样太多。扫描的代价是要处理少量怪写法，
 * 但收益是**不会因为对象表畸形就整份读不出**。
 */
function scanImages(buf, raw) {
  const found = [];
  const re = /<<([\s\S]*?)\/Subtype\s*\/Image([\s\S]*?)>>\s*stream\r?\n?/g;
  let m;
  while ((m = re.exec(raw))) {
    const dict = m[1] + m[2];
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) continue;

    const width = num(dict, 'Width');
    const height = num(dict, 'Height');
    if (!width || !height) continue;

    // /Filter 可能是单个名字，也可能是数组；这里只需要知道**是不是 Flate**
    const filterNames = [...dict.matchAll(/\/(FlateDecode|DCTDecode|JPXDecode|CCITTFaxDecode|LZWDecode|RunLengthDecode)/g)]
      .map((x) => x[1]);
    const isImageMask = /\/ImageMask\s+true/.test(dict);

    found.push({
      dict,
      width,
      height,
      bytes: end - start,
      // ⚠️ PDF 规范里 `endstream` 前面**通常有一个换行**，那个换行不属于
      //    图片数据。Flate 解压时多一个尾字节无所谓，但 JPEG 是原样透传的 ——
      //    多带一个 \n，浏览器能不能解码就说不准了。
      start,
      end: trimEol(raw, start, end),
      bits: num(dict, 'BitsPerComponent') || 8,
      predictor: num(dict, 'Predictor') || 1,
      isImageMask,
      hasFlate: filterNames.includes('FlateDecode'),
      hasJpeg: filterNames.includes('DCTDecode'),
      filterNames,
      colorSpace: /\/ColorSpace\s*\/(\w+)/.exec(dict)?.[1] || '',
    });
  }
  return found;
}

/**
 * 从 PDF 里抽出一张适合给用户看的位图。
 *
 * @param {Buffer} buffer
 * @param {object} [opts] 覆盖默认限额（测试用）
 * @returns {{data: Buffer, mime: string, width: number, height: number, kind: string}}
 * @throws {Error} 带**中文、面向用户**的原因
 */
export function extractTimetableImage(buffer, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...opts };

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('没有收到文件内容');
  }
  if (buffer.length < PDF_MAGIC.length
    || !buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    // 扩展名改成 .pdf 不算数 —— 这里只看内容
    throw new Error('这个文件不是 PDF（内容开头不是 %PDF-）。如果你手里是 Word 或图片，请先导出成 PDF。');
  }
  if (buffer.length > limits.maxBytes) {
    throw new Error(`PDF 太大了（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 ${Math.round(limits.maxBytes / 1024 / 1024)}MB。`
      + '如果只是要导入课表，可以在教务系统里只导出课表那一页。');
  }

  const raw = buffer.toString('latin1');

  if (/\/Encrypt\b/.test(raw)) {
    throw new Error('这份 PDF 加了密码（加密），读不出里面的图片。请先在教务系统里导出不带密码的版本。');
  }

  const pages = countPages(raw);
  if (pages > limits.maxPages) {
    throw new Error(`这份 PDF 有 ${pages} 页，超过上限 ${limits.maxPages} 页。请只导出课表那一页再上传。`);
  }

  const images = scanImages(buffer, raw);
  if (images.length === 0) {
    throw new Error('这份 PDF 里没有内嵌图片，课表可能是**文字**排出来的。'
      + '这种情况请用「粘贴表格内容」那条路，或者手动添加课程。');
  }

  // 挑最大的那张（按压缩后字节数）。
  // ⚠️ 不能按像素面积挑：pdfmake 导出的课表里，真正的课表和它的灰度软遮罩
  //    尺寸**完全一样**（都是 3366×1850），按面积挑会平局、谁先出现谁赢，
  //    结果可能拿到那张全灰的遮罩 —— 用户看到的是一片灰。
  const sorted = images
    .filter((im) => !im.isImageMask)
    .sort((a, b) => b.bytes - a.bytes);
  if (sorted.length === 0) {
    throw new Error('这份 PDF 里的图片是遮罩层，没有可以显示的内容。');
  }

  const errors = [];
  for (const img of sorted) {
    const pixelCount = img.width * img.height;
    if (pixelCount > limits.maxPixels) {
      errors.push(`图太大（${img.width}×${img.height}）`);
      continue;
    }

    // ---- JPEG（DCTDecode）：字节本身就是一张 JPEG，直接原样给浏览器，不用重编码 ----
    if (img.hasJpeg && !img.hasFlate) {
      const data = buffer.subarray(img.start, img.end);
      if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
        return {
          data, mime: 'image/jpeg', width: img.width, height: img.height, kind: 'jpeg',
        };
      }
      errors.push('JPEG 数据不完整');
      continue;
    }

    if (!img.hasFlate) {
      errors.push(`不支持的压缩方式（${img.filterNames.join('、') || '未知'}）`);
      continue;
    }
    if (img.bits !== 8) {
      errors.push(`不支持 ${img.bits} 位深的图`);
      continue;
    }
    const channels = CHANNELS_BY_COLORSPACE[img.colorSpace];
    if (!channels) {
      errors.push(`不支持的色彩空间（${img.colorSpace || '未标注'}）`);
      continue;
    }

    let inflated;
    try {
      // ⚠️ maxOutputLength 是这里最要紧的一个参数：不设的话，一个几百字节的
      //    Flate 流能解出几个 GB，直接把进程撑死（zip bomb）。
      inflated = zlib.inflateSync(buffer.subarray(img.start, img.end), {
        maxOutputLength: limits.maxInflated,
      });
    } catch (err) {
      errors.push(err?.code === 'ERR_BUFFER_TOO_LARGE'
        ? '图片解压后超过安全上限'
        : '图片数据解不开（可能文件损坏）');
      continue;
    }

    let pixels = inflated;
    if (img.predictor >= 10) {
      try {
        pixels = undoPngPredictor(inflated, img.width, img.height, channels);
      } catch (err) {
        errors.push(`还原行预测器失败：${err.message}`);
        continue;
      }
    }

    const needed = img.width * img.height * channels;
    if (pixels.length < needed) {
      errors.push('图片像素数据不完整');
      continue;
    }

    return {
      data: encodePng({
        width: img.width,
        height: img.height,
        channels,
        data: pixels.subarray(0, needed),
      }),
      mime: 'image/png',
      width: img.width,
      height: img.height,
      kind: 'flate',
    };
  }

  throw new Error(`没能从这份 PDF 里读出可显示的课表图片：${errors.join('；')}。`
    + '可以试试用「粘贴表格内容」那条路，或者手动添加课程。');
}
