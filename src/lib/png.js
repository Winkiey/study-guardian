/**
 * 极简 PNG 编码器（零依赖，只用 node:zlib）。
 *
 * 为什么需要它：从 PDF 里抽出来的内嵌位图是**裸像素**（Flate 压过的 RGB 数组），
 * 浏览器不认识，得包成 PNG 才能给 <img> 用。走系统工具（ImageMagick / poppler）
 * 也能转，但那等于为了显示一张图多装一个包 —— 而 PNG 的容器格式本身极简单：
 * 一个签名 + 三个块（IHDR / IDAT / IEND），每块就是「长度 + 类型 + 数据 + CRC」。
 *
 * 只做需要的那一小块，不追求完整实现：
 *   · 只输出 8 位深
 *   · 只输出灰度(1) / RGB(3) / RGBA(4) 通道
 *   · 每行用 filter 0（不过滤）
 * 对课表这种白底黑字的图，PNG 自带的 deflate 就能压掉 98%（实测 17.8MB → 280KB），
 * 再用更聪明的行过滤器意义不大。
 */

import zlib from 'node:zlib';

/** CRC-32 查表（PNG 每个块末尾都要） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 组装一个 PNG 块：长度(4) + 类型(4) + 数据 + CRC(4) */
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 通道数 → PNG 颜色类型 */
const COLOR_TYPE = { 1: 0, 3: 2, 4: 6 };

/**
 * 把裸像素编成 PNG。
 *
 * @param {object} p
 * @param {number} p.width
 * @param {number} p.height
 * @param {1|3|4} p.channels 灰度 / RGB / RGBA
 * @param {Buffer} p.data 长度必须正好是 width * height * channels
 * @param {number} [p.level] deflate 级别，默认 6
 * @returns {Buffer}
 */
export function encodePng({ width, height, channels, data, level = 6 }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('PNG 尺寸不合法');
  }
  // ⚠️ 必须用 `in` 判断，不能用 `!COLOR_TYPE[channels]`：
  //    灰度通道数 1 对应的颜色类型是 **0**，而 0 是 falsy ——
  //    写 `!COLOR_TYPE[1]` 会把合法的灰度图判成"不支持的通道数"。
  //    这个坑是测试抓出来的（灰度用例直接报"只支持 1/3/4"）。
  if (!(channels in COLOR_TYPE)) {
    throw new Error(`不支持的通道数：${channels}（只支持 1 / 3 / 4）`);
  }
  const stride = width * channels;
  const expected = stride * height;
  // ⚠️ 长度不对必须当场报错。少读了字节的话，图会「歪着」显示 ——
  // 每行差几个像素，越往下越歪。那种错很难一眼看出来是数据长度的问题。
  if (!Buffer.isBuffer(data) || data.length !== expected) {
    throw new Error(`像素数据长度不对：期望 ${expected}，实际 ${data?.length ?? '不是 Buffer'}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                    // 位深
  ihdr[9] = COLOR_TYPE[channels]; // 颜色类型
  ihdr[10] = 0;                   // 压缩方式（只有 0）
  ihdr[11] = 0;                   // 过滤方式（只有 0）
  ihdr[12] = 0;                   // 隔行扫描：无

  // 每行前面加一个 filter 字节（0 = 不过滤）
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 还原 PNG 行过滤器（PDF 的 /Predictor >= 10 会用它）。
 *
 * 就地还原，返回新的 Buffer。五种过滤器（None / Sub / Up / Average / Paeth）
 * 都是「按左边、上边、左上三个邻居预测，存的是差值」，所以必须**逐行**按顺序还原
 * —— 第 N 行依赖第 N-1 行的结果，不能并行。
 *
 * @param {Buffer} src 带 filter 字节的原始数据：每行 1 + stride 字节
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 */
export function undoPngPredictor(src, width, height, channels) {
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (src.length < expected) {
    throw new Error(`带预测器的数据长度不足：期望至少 ${expected}，实际 ${src.length}`);
  }

  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);   // 第一行的「上一行」全是 0
  const cur = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = src[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = src[rowStart + x];
      const left = x >= channels ? cur[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      let value = raw;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        // Paeth：在左、上、左上里挑一个最接近「左下+右上-左上」的
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
      } else if (filter !== 0) {
        throw new Error(`不认识的 PNG 行过滤器：${filter}`);
      }
      cur[x] = value & 0xff;
    }
    cur.copy(out, y * stride);
    prev = Buffer.from(cur);   // 复制一份：cur 下一轮会被覆盖
  }

  return out;
}
