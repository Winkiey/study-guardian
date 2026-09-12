/**
 * 生成 PWA 图标（PNG）。
 *
 * 为什么要有这个脚本：PWA 的 manifest 需要 PNG 图标，
 * 但我们不想在仓库里塞二进制文件、也不想引入 canvas 之类的库。
 * PNG 的最小实现只需要 zlib + CRC32，几十行就够了。
 *
 * 用法：node scripts/make-icons.js
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');

// ------------------------------------------------------------
// 最小 PNG 编码器
// ------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/**
 * 把 RGBA 像素数组编码成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度 = width * height * 4
 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型：RGBA
  ihdr[10] = 0;  // 压缩方法
  ihdr[11] = 0;  // 滤波方法
  ihdr[12] = 0;  // 隔行扫描：无

  // 每行前面加一个滤波类型字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------
// 画图标：渐变圆角方块 + 一本翻开的书
// ------------------------------------------------------------

// 跟 app.css 里的 --c-primary / --c-accent 保持一致，
// 也跟 favicon.svg 的渐变一致。改一处就要三处一起改。
const COLOR_A = [0x3a, 0x63, 0xe8]; // 主色
const COLOR_B = [0x7c, 0x5c, 0xff]; // 渐变末端

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 判断点是否在圆角矩形内 */
function inRoundedRect(x, y, size, radius) {
  const r = radius;
  if (x >= r && x <= size - r) return y >= 0 && y <= size;
  if (y >= r && y <= size - r) return x >= 0 && x <= size;

  const cx = x < r ? r : size - r;
  const cy = y < r ? r : size - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 用「到线段距离」画粗线（书页轮廓） */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * dx;
  const ny = y1 + t * dy;
  return Math.hypot(px - nx, py - ny);
}

/**
 * 渲染图标。
 * @param {number} size 边长
 * @param {boolean} maskable 是否做成可遮罩版本（内容缩小、背景铺满）
 */
function renderIcon(size, maskable = false) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 64; // 设计稿以 64x64 为基准

  // 可遮罩版本的安全区是中心 80%
  const inset = maskable ? size * 0.1 : 0;
  const drawSize = size - inset * 2;

  // 书页轮廓（相对 64x64 设计稿的坐标）
  const strokeW = 3.2 * scale * (maskable ? 0.82 : 1);
  const bookTop = 20 * scale;
  const bookBottom = 46 * scale;
  const midX = 32 * scale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;

      // 局部坐标（用于圆角与图形绘制）
      const lx = x - inset;
      const ly = y - inset;

      if (maskable && (lx < 0 || ly < 0 || lx > drawSize || ly > drawSize)) {
        // 可遮罩版本：圆角外仍是纯色，避免被系统裁切后出现透明边
        const t = (x + y) / (size * 2);
        rgba[idx] = lerp(COLOR_A[0], COLOR_B[0], t);
        rgba[idx + 1] = lerp(COLOR_A[1], COLOR_B[1], t);
        rgba[idx + 2] = lerp(COLOR_A[2], COLOR_B[2], t);
        rgba[idx + 3] = 255;
        continue;
      }

      const radius = maskable ? 0 : 14 * scale;

      if (!maskable && !inRoundedRect(x, y, size, radius)) {
        rgba[idx + 3] = 0;
        continue;
      }

      // 背景渐变（左上 → 右下）
      const t = (x + y) / (size * 2);
      let r = lerp(COLOR_A[0], COLOR_B[0], t);
      let g = lerp(COLOR_A[1], COLOR_B[1], t);
      let b = lerp(COLOR_A[2], COLOR_B[2], t);

      // 画书：两条竖线 + 两条斜线 + 中缝 + 顶部圆点
      const lines = [
        // 左页：左上 → 左下（竖）
        [18 * scale, bookTop, 18 * scale, bookBottom],
        // 右页：右上 → 右下
        [46 * scale, bookTop, 46 * scale, bookBottom],
        // 左页顶部斜线
        [18 * scale, bookTop, midX - 1 * scale, bookTop + 3 * scale],
        // 右页顶部斜线
        [46 * scale, bookTop, midX + 1 * scale, bookTop + 3 * scale],
        // 底部
        [18 * scale, bookBottom, midX - 1 * scale, bookBottom - 2 * scale],
        [46 * scale, bookBottom, midX + 1 * scale, bookBottom - 2 * scale],
        // 中缝
        [midX, bookTop + 3 * scale, midX, bookBottom - 1 * scale],
      ];

      let minDist = Infinity;
      for (const [x1, y1, x2, y2] of lines) {
        minDist = Math.min(minDist, distToSegment(lx, ly, x1, y1, x2, y2));
      }

      // 抗锯齿：距离小于线宽为实心，边缘做一点羽化
      const half = strokeW / 2;
      let alpha = 0;
      if (minDist <= half - 0.5) alpha = 1;
      else if (minDist < half + 0.5) alpha = (half + 0.5 - minDist);

      if (alpha > 0) {
        r = lerp(r, 255, alpha);
        g = lerp(g, 255, alpha);
        b = lerp(b, 255, alpha);
      }

      // 顶部小圆点（代表提醒）
      const dotDist = Math.hypot(lx - midX, ly - 12 * scale);
      const dotR = 2.6 * scale;
      if (dotDist < dotR + 0.5) {
        const dotAlpha = dotDist <= dotR - 0.5 ? 1 : Math.max(0, dotR + 0.5 - dotDist);
        r = lerp(r, 255, dotAlpha);
        g = lerp(g, 255, dotAlpha);
        b = lerp(b, 255, dotAlpha);
      }

      rgba[idx] = Math.round(r);
      rgba[idx + 1] = Math.round(g);
      rgba[idx + 2] = Math.round(b);
      rgba[idx + 3] = 255;
    }
  }

  return encodePng(size, size, rgba);
}

// ------------------------------------------------------------
// 输出
// ------------------------------------------------------------

function main() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  const targets = [
    { file: 'icon-192.png', size: 192, maskable: false },
    { file: 'icon-512.png', size: 512, maskable: false },
    { file: 'icon-maskable.png', size: 512, maskable: true },
    { file: 'apple-touch-icon.png', size: 180, maskable: false },
  ];

  for (const target of targets) {
    const png = renderIcon(target.size, target.maskable);
    const outPath = path.join(PUBLIC_DIR, target.file);
    fs.writeFileSync(outPath, png);
    console.log(`✓ ${target.file}  ${target.size}×${target.size}  ${(png.length / 1024).toFixed(1)} KB`);
  }

  console.log(`\n图标已生成到 ${PUBLIC_DIR}`);
}

main();
