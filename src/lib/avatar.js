/**
 * 头像：类型识别、尺寸校验、按用户隔离的存储。
 *
 * ── 为什么不能信扩展名和 MIME ──────────────────────────────────
 * 上传时浏览器给的 Content-Type 和文件名都是**用户能改的**。
 * 一份 `avatar.php` 改名成 `a.png`、MIME 写成 image/png，只按那两样判断
 * 就会照单全收。所以这里看**文件头的那几个字节** —— 那是改不了的。
 *
 * ── 为什么要限尺寸 ────────────────────────────────────────────
 * 光限体积挡不住「解压炸弹」式的图：一个几十 KB 的 PNG 可以声明
 * 50000×50000 像素。所以除了字节上限，还要读图片自己声明的宽高并设上限。
 * （这一点和 PDF 那边是同一个道理，见 src/lib/import/pdf-image.js。）
 *
 * ── 存储 ─────────────────────────────────────────────────────
 * 一个用户一个文件：`data/avatars/<userId>.<ext>`。
 * 路径**完全由 userId 拼出来**，不含任何用户提供的字符串 ——
 * 这样就不存在「路径穿越」这类问题的余地，不需要再做一层过滤。
 * 换头像时先删掉旧扩展名的文件，避免出现两个文件、读到哪个看运气。
 */

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { get, run } from '../db/index.js';

/** 头像上限：2MB。够放一张手机拍的图了，再大就该先裁一下。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** 像素上限：2000×2000。头像显示出来的地方最大也就一百多像素。 */
export const AVATAR_MAX_PIXELS = 2000 * 2000;

/**
 * 支持的格式。刻意只收这两种：手机拍照是 JPEG、截图是 PNG，覆盖绝大多数情况。
 *
 * ⚠️ 这里有两套名字，必须分清，别混用：
 *   · **type** —— 给 sniffImageType / readImageSize 用的（'jpeg'）
 *   · **ext**  —— 存进库、拼文件名的（'jpg'）
 * 第一版就是混了：库里存的是 'jpg'，而 avatarMime 按 'jpeg' 去查表，
 * 于是**一张 JPEG 头像被当成 PNG 发出去**（浏览器多半还是能显示，
 * 但这是靠容错蒙过去的）。现在查表统一用扩展名，两边各有一个映射。
 */
const TYPE_TO_EXT = { png: 'png', jpeg: 'jpg' };
const EXT_TO_MIME = { png: 'image/png', jpg: 'image/jpeg' };

export function avatarMime(ext) {
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

/** 这个扩展名是不是我们支持的 */
function isKnownExt(ext) {
  return Object.prototype.hasOwnProperty.call(EXT_TO_MIME, ext);
}

export function avatarDir() {
  const dir = path.join(config.dataDir, 'avatars');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 某个用户的头像文件路径。路径里只有数字 userId 和固定扩展名。 */
export function avatarPath(userId, ext) {
  const safeExt = isKnownExt(ext) ? ext : 'png';
  return path.join(avatarDir(), `${Number(userId)}.${safeExt}`);
}

/**
 * 看文件头判断是什么图。认不出来返回 null。
 *
 * 只认三种**确定**的开头，其余一律拒绝 —— 包括 WebP。
 * 不收 WebP 是有意的：它的宽高藏在 VP8/VP8L/VP8X 三种不同的块里，
 * 解析起来分支不少，而收益很小（手机拍照出 JPEG、截图出 PNG）。
 * 真要支持的话，在下面加一个分支、并在 readImageSize 里补上尺寸解析即可。
 */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  // PNG：8 字节固定签名
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  // JPEG：FFD8FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  return null;
}

/**
 * 读图片自己声明的宽高。读不出来返回 null。
 *
 * 两个格式的读法完全不同：
 *   · PNG 固定：IHDR 块紧跟签名，宽高是第 16/20 字节起的两个大端 32 位整数；
 *   · JPEG 要**扫段**：从 FFD8 开始一段段跳，找到 SOFn（C0–CF，去掉 C4/C8/CC）
 *     才能拿到宽高。所以不能只看开头几个字节。
 */
export function readImageSize(buffer, type) {
  if (!Buffer.isBuffer(buffer)) return null;

  if (type === 'png') {
    // 9 字节签名+长度+类型，然后 4 字节宽、4 字节高
    if (buffer.length < 24) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (type === 'jpeg') {
    let i = 2;
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) { i += 1; continue; }
      const marker = buffer[i + 1];
      // 填充字节和 RSTn 没有长度字段，跳过
      if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9)) { i += 1; continue; }
      const len = buffer.readUInt16BE(i + 2);
      // SOF0–SOF15，但要排除 C4(DHT) / C8(JPG) / CC(DAC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (i + 9 >= buffer.length) return null;
        return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
      if (len < 2) return null;   // 段长不合法，别再往下扫了（防死循环）
      i += 2 + len;
    }
    return null;
  }

  return null;
}

/**
 * 校验一份上传的头像，返回 { type, ext, width, height }。
 * @throws {Error} 中文、面向用户的原因
 */
export function checkAvatar(buffer, { maxBytes = AVATAR_MAX_BYTES, maxPixels = AVATAR_MAX_PIXELS } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('没有收到图片内容');
  }
  if (buffer.length > maxBytes) {
    throw new Error(`头像不能超过 ${Math.round(maxBytes / 1024 / 1024 * 10) / 10}MB，`
      + `现在这张是 ${(buffer.length / 1024 / 1024).toFixed(1)}MB。可以先裁小一点再上传。`);
  }

  // 先看文件头，再看内容 —— 顺序不能反：类型都不知道就没法读宽高
  const type = sniffImageType(buffer);
  if (!type) {
    throw new Error('这个文件不是 PNG 或 JPEG 图片。请上传 .png 或 .jpg 格式的图片'
      + '（手机相册里的照片一般是 JPEG，截图一般是 PNG）。');
  }

  const size = readImageSize(buffer, type);
  if (!size || !size.width || !size.height) {
    throw new Error('这张图片读不出尺寸，可能已经损坏了。换一张试试。');
  }
  // 上限针对的是**声明的**像素数：几十 KB 的文件可以声称自己是 5 万×5 万
  if (size.width * size.height > maxPixels) {
    throw new Error(`图片太大了（${size.width}×${size.height}），`
      + `长宽相乘不能超过 ${maxPixels / 10000} 万像素。先裁小一点再上传。`);
  }

  return { type, ext: TYPE_TO_EXT[type], width: size.width, height: size.height };
}

/** 这个用户的头像文件名（存在库里的是扩展名，不是完整路径） */
export function avatarExtOf(userId) {
  const row = get('SELECT avatar_ext FROM users WHERE id = ?', userId);
  return row?.avatar_ext || '';
}

/**
 * 存头像：校验 → 清掉旧文件 → 写新的 → 记下扩展名。
 *
 * 旧文件必须删：不然从 png 换成 jpg 之后磁盘上会有两个文件，
 * 而读到哪一个取决于查找顺序 —— 换完头像还显示旧图就是这么来的。
 */
export function saveAvatar(userId, buffer) {
  const info = checkAvatar(buffer);
  removeAvatar(userId);
  const target = avatarPath(userId, info.ext);
  fs.writeFileSync(target, buffer, { mode: 0o600 });
  run('UPDATE users SET avatar_ext = ? WHERE id = ?', info.ext, userId);
  return info;
}

/** 删掉头像（文件和库里的标记一起） */
export function removeAvatar(userId) {
  const old = avatarExtOf(userId);
  if (old) {
    // 两个扩展名都试一遍：库里记的可能是旧的
    for (const ext of ['png', 'jpg']) {
      try { fs.unlinkSync(avatarPath(userId, ext)); } catch { /* 不存在就算了 */ }
    }
  }
  run("UPDATE users SET avatar_ext = '' WHERE id = ?", userId);
}

/** 头像文件在不在、能不能读。用于渲染时决定要不要给 <img> */
export function avatarExists(userId) {
  const ext = avatarExtOf(userId);
  if (!ext) return false;
  try {
    return fs.statSync(avatarPath(userId, ext)).isFile();
  } catch {
    return false;
  }
}
