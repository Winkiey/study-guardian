/**
 * 零第三方依赖的 ZIP 读取器（只使用 node:zlib）
 *
 * 设计要点：
 * - 通过 EOCD（End of Central Directory）从文件尾部定位中央目录，
 *   因此「前面有其它数据」的 zip（自解压包、被拼接过的 zip）也能读取。
 * - 支持 method 0（stored）与 method 8（deflate）。
 * - 支持 ZIP64：读取 ZIP64 EOCD（EOCD64）记录 + locator，以及条目里的
 *   ZIP64 扩展字段（0x0001），用于补齐 4GB 以上的大小 / 偏移。
 *   已知局限：EOCD64 的定位优先使用 locator 中记录的偏移，失败时退化为
 *   「EOCD64 紧邻 locator 之前」以及「向前扫描 ZIP64 EOCD 签名」两种兜底策略；
 *   带超长 ZIP64 可扩展数据段（extensible data sector）且整体前置偏移的极端
 *   文件可能无法定位（会抛出中文错误，而不会返回错误数据）。
 * - 文件名按 general purpose bit 11 判断编码；未置位时先尝试 UTF-8，
 *   出现替换字符再尝试 GBK（中文课件的 Windows 压缩工具常见做法）。
 * - 每个条目在解压后做 CRC32 校验，以及声明大小校验；失败抛出中文错误。
 * - 不支持分卷（多磁盘）zip。
 */

import { inflateRawSync } from 'node:zlib';

/** 本地文件头签名 'PK\3\4' */
const SIG_LOCAL_FILE = 0x04034b50;
/** 中央目录条目签名 'PK\1\2' */
const SIG_CENTRAL_FILE = 0x02014b50;
/** EOCD 签名 'PK\5\6' */
const SIG_EOCD = 0x06054b50;
/** ZIP64 EOCD 签名 'PK\6\6' */
const SIG_ZIP64_EOCD = 0x06064b50;
/** ZIP64 EOCD 定位器签名 'PK\6\7' */
const SIG_ZIP64_LOCATOR = 0x07064b50;

/** EOCD 固定部分长度 */
const EOCD_SIZE = 22;
/** ZIP 注释最大长度（16 位字段） */
const MAX_ZIP_COMMENT = 0xffff;
/** ZIP64 EOCD 记录固定部分长度 */
const ZIP64_EOCD_FIXED_SIZE = 56;
/** ZIP64 locator 长度 */
const ZIP64_LOCATOR_SIZE = 20;
/** ZIP64 扩展字段 id */
const ZIP64_EXTRA_ID = 0x0001;
/** 通用位标记：文件名 / 注释为 UTF-8 */
const FLAG_UTF8 = 0x800;
/** 默认单个条目解压后大小上限（防御 zip 炸弹 / 异常声明） */
const DEFAULT_MAX_ENTRY_SIZE = 512 * 1024 * 1024;

/** CRC32 查表（多项式 0xedb88320） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32 校验值
 * @param {Buffer|Uint8Array} buffer 待计算的数据
 * @param {number} [seed=0] 前一段数据的 CRC 结果，便于分段累计
 * @returns {number} 无符号 32 位 CRC32
 */
export function crc32(buffer, seed = 0) {
  let c = (~seed) >>> 0;
  for (let i = 0; i < buffer.length; i++) {
    c = (CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return ~c >>> 0;
}

/**
 * 读取 8 字节小端无符号整数（超出 JS 安全整数范围时报错）
 * @param {Buffer} buffer 数据
 * @param {number} offset 偏移
 * @returns {number}
 */
function readUInt64LE(buffer, offset) {
  if (offset < 0 || offset + 8 > buffer.length) {
    throw new Error('ZIP 结构异常：读取 64 位字段时越界');
  }
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('ZIP 结构异常：64 位偏移超出 JavaScript 安全整数范围，无法处理');
  }
  return Number(value);
}

/**
 * 从文件尾部查找 EOCD 记录位置
 * @param {Buffer} buffer zip 数据
 * @returns {number} EOCD 起始偏移
 */
function findEocd(buffer) {
  const len = buffer.length;
  if (len < EOCD_SIZE) throw new Error('不是有效的 ZIP 文件：数据长度不足 22 字节');
  const minPos = Math.max(0, len - EOCD_SIZE - MAX_ZIP_COMMENT);
  let fallback = -1;
  for (let pos = len - EOCD_SIZE; pos >= minPos; pos--) {
    if (buffer.readUInt32LE(pos) !== SIG_EOCD) continue;
    const commentLen = buffer.readUInt16LE(pos + 20);
    // 优先接受「注释长度刚好补到文件末尾」的记录
    if (pos + EOCD_SIZE + commentLen === len) return pos;
    if (fallback < 0 && pos + EOCD_SIZE + commentLen <= len) fallback = pos;
  }
  if (fallback >= 0) return fallback;
  throw new Error('不是有效的 ZIP 文件：找不到中央目录结束记录（EOCD）');
}

/**
 * 判断 pos 处是否是一个 ZIP64 EOCD 记录
 * @param {Buffer} buffer zip 数据
 * @param {number} pos 位置
 * @returns {boolean}
 */
function isZip64EocdAt(buffer, pos) {
  return (
    Number.isInteger(pos) &&
    pos >= 0 &&
    pos + ZIP64_EOCD_FIXED_SIZE <= buffer.length &&
    buffer.readUInt32LE(pos) === SIG_ZIP64_EOCD
  );
}

/**
 * 读取 ZIP64 EOCD 记录内容
 * @param {Buffer} buffer zip 数据
 * @param {number} pos 记录起始位置
 * @returns {{ count: number, size: number, offset: number, anchor: number }}
 */
function readZip64EocdAt(buffer, pos) {
  const recordSize = readUInt64LE(buffer, pos + 4);
  if (recordSize < 44) {
    throw new Error('ZIP64 结构异常：ZIP64 EOCD 记录长度字段非法');
  }
  const count = readUInt64LE(buffer, pos + 32);
  const size = readUInt64LE(buffer, pos + 40);
  const offset = readUInt64LE(buffer, pos + 48);
  return { count, size, offset, anchor: pos };
}

/**
 * 解析 ZIP64 EOCD 记录，返回中央目录条目数、大小与偏移
 * @param {Buffer} buffer zip 数据
 * @param {number} eocdPos EOCD 位置
 * @returns {{ count: number, size: number, offset: number, anchor: number }}
 */
function parseZip64Eocd(buffer, eocdPos) {
  const locatorPos = eocdPos - ZIP64_LOCATOR_SIZE;
  const hasLocator =
    locatorPos >= 0 && buffer.readUInt32LE(locatorPos) === SIG_ZIP64_LOCATOR;

  /** 候选 EOCD64 位置：locator 记录的偏移（以 zip 起点为基准）、紧随 locator 之前 */
  if (hasLocator && locatorPos + 16 + 8 <= buffer.length) {
    const declared = readUInt64LE(buffer, locatorPos + 8);
    if (isZip64EocdAt(buffer, declared)) return readZip64EocdAt(buffer, declared);
    const adjacent = locatorPos - ZIP64_EOCD_FIXED_SIZE;
    if (isZip64EocdAt(buffer, adjacent)) return readZip64EocdAt(buffer, adjacent);
  }

  // 兜底：在 EOCD 之前最多 1MB 范围内向前扫描 ZIP64 EOCD 签名
  const upper = hasLocator ? locatorPos : eocdPos;
  const lower = Math.max(0, upper - 1024 * 1024);
  for (let pos = upper - 4; pos >= lower; pos--) {
    if (buffer.readUInt32LE(pos) === SIG_ZIP64_EOCD) return readZip64EocdAt(buffer, pos);
  }
  throw new Error(
    'ZIP64 文件结构异常：无法定位 ZIP64 EOCD 记录（可能不是标准 ZIP64 或文件已损坏）',
  );
}

/**
 * 在扩展字段中查找 ZIP64 扩展字段，补齐 32 位头部被置为 0xFFFFFFFF 的字段
 * @param {Buffer} extra 扩展字段数据（已截取）
 * @param {{ size: number, compressedSize: number, offset: number, diskStart: number }} raw 原始值
 * @returns {{ size: number, compressedSize: number, offset: number, diskStart: number, isZip64: boolean }}
 */
function applyZip64Extra(extra, raw) {
  const result = { ...raw, isZip64: false };
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (p + 4 + size > extra.length) {
      throw new Error('ZIP 结构异常：条目扩展字段长度越界');
    }
    if (id === ZIP64_EXTRA_ID) {
      let q = p + 4;
      const need = [];
      if (raw.size === 0xffffffff) need.push('size');
      if (raw.compressedSize === 0xffffffff) need.push('compressedSize');
      if (raw.offset === 0xffffffff) need.push('offset');
      if (raw.diskStart === 0xffff) need.push('diskStart');
      for (const field of need) {
        const width = field === 'diskStart' ? 4 : 8;
        if (q + width > p + 4 + size) {
          throw new Error('ZIP64 结构异常：ZIP64 扩展字段内容不足');
        }
        result[field] = width === 8 ? readUInt64LE(extra, q) : extra.readUInt32LE(q);
        q += width;
      }
      result.isZip64 = need.length > 0;
      if (result.isZip64) break;
    }
    p += 4 + size;
  }
  if (
    result.size === 0xffffffff ||
    result.compressedSize === 0xffffffff ||
    result.offset === 0xffffffff
  ) {
    throw new Error('ZIP64 结构异常：条目缺少 ZIP64 扩展字段，无法获知真实大小 / 偏移');
  }
  return result;
}

/**
 * 使用指定编码严格解码（失败返回 null）
 * @param {Buffer} bytes 原始字节
 * @param {string} encoding 编码名
 * @returns {string|null}
 */
function tryDecode(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 解码条目文件名：bit 11 置位表示 UTF-8，否则按 UTF-8 解码，
 * 出现替换字符时再尝试 GBK（兼容中文压缩工具）。
 * @param {Buffer} bytes 文件名原始字节
 * @param {number} flags 通用位标记
 * @returns {string}
 */
function decodeEntryName(bytes, flags) {
  if (bytes.length === 0) return '';
  if (flags & FLAG_UTF8) return bytes.toString('utf8');
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  const gbk = tryDecode(bytes, 'gbk');
  if (gbk && !gbk.includes('\uFFFD')) return gbk;
  return utf8;
}

/**
 * 把 zip 路径规范化：处理 './'、'../'、重复斜杠与开头的斜杠
 * 供 office.js 等上层解析 OOXML 关系时复用。
 * @param {string} path 相对 / 绝对 zip 路径
 * @param {string} [base=''] 基准目录（不带结尾斜杠）
 * @returns {string} 规范化后的路径（不带开头斜杠）
 */
export function normalizeZipPath(path, base = '') {
  if (typeof path !== 'string') return '';
  let raw = path.replace(/\\/g, '/');
  if (!raw) return '';
  const absolute = raw.startsWith('/');
  if (absolute) {
    raw = raw.replace(/^\/+/, '');
    base = '';
  }
  const segments = [];
  for (const seg of `${base ? `${base}/` : ''}${raw}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/');
}

/**
 * 规范化条目名：ZIP 规范要求路径分隔符为 '/'，但少数 Windows 环境下的写入方
 * （例如 .NET Framework 的 System.IO.Compression.ZipFile）会写成 '\'，
 * 这里统一成 '/'，否则上层按 'word/document.xml' 之类的路径会找不到部件。
 * @param {string} name 原始条目名
 * @returns {string}
 */
function normalizeEntryName(name) {
  return name.includes('\\') ? name.replace(/\\/g, '/') : name;
}

/**
 * 从 Buffer 读取 zip 的全部条目
 * @param {Buffer|Uint8Array} input zip 数据
 * @param {{ maxEntrySize?: number }} [options] maxEntrySize：单个条目解压后大小上限（字节），默认 512MB
 * @returns {{
 *   entries: Map<string, { name: string, size: number, compressedSize: number, method: number,
 *     crc32: number, isDirectory: boolean, flags: number, localHeaderOffset: number, zip64: boolean }>,
 *   read(name: string): Buffer,
 *   readText(name: string): string,
 *   has(name: string): boolean,
 *   list(): string[]
 * }} zip 读取器
 */
export function readZip(input, options = {}) {
  const buffer = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : null;
  if (!buffer) throw new Error('readZip 需要传入 Buffer 或 Uint8Array');
  const len = buffer.length;
  const maxEntrySize =
    Number.isFinite(options.maxEntrySize) && options.maxEntrySize > 0
      ? options.maxEntrySize
      : DEFAULT_MAX_ENTRY_SIZE;

  const eocdPos = findEocd(buffer);
  const diskNumber = buffer.readUInt16LE(eocdPos + 4);
  const cdDiskNumber = buffer.readUInt16LE(eocdPos + 6);
  let entryCount = buffer.readUInt16LE(eocdPos + 10);
  let cdSize = buffer.readUInt32LE(eocdPos + 12);
  let cdOffset = buffer.readUInt32LE(eocdPos + 16);
  let anchor = eocdPos;

  const needZip64 =
    entryCount === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    diskNumber === 0xffff ||
    cdDiskNumber === 0xffff ||
    buffer.readUInt16LE(eocdPos + 8) === 0xffff;

  if (needZip64) {
    const zip64 = parseZip64Eocd(buffer, eocdPos);
    entryCount = zip64.count;
    cdSize = zip64.size;
    cdOffset = zip64.offset;
    anchor = zip64.anchor;
  } else if (diskNumber !== 0 || cdDiskNumber !== 0) {
    throw new Error('暂不支持分卷（多磁盘）ZIP 文件');
  }

  if (!Number.isSafeInteger(entryCount) || entryCount < 0) {
    throw new Error('ZIP 结构异常：中央目录条目数非法');
  }

  // 计算 zip 数据在文件中的真实起点（支持前面有其它数据的 zip）
  let base = anchor - cdSize - cdOffset;
  if (base < 0) base = 0;
  const cdStart = base + cdOffset;
  const hasCentral =
    cdStart >= 0 &&
    cdStart + 4 <= len &&
    buffer.readUInt32LE(cdStart) === SIG_CENTRAL_FILE;
  if (!hasCentral && entryCount > 0) {
    if (cdOffset + 4 <= len && buffer.readUInt32LE(cdOffset) === SIG_CENTRAL_FILE) {
      base = 0;
    } else {
      throw new Error('ZIP 结构异常：中央目录位置校验失败（文件可能已损坏或被截断）');
    }
  } else if (!hasCentral && entryCount === 0) {
    base = 0;
  }

  const entries = new Map();
  let cursor = base + cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > len) {
      throw new Error(`ZIP 结构异常：第 ${i + 1} 个中央目录条目超出文件范围（文件可能被截断）`);
    }
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL_FILE) {
      throw new Error(`ZIP 结构异常：第 ${i + 1} 个中央目录条目签名错误（文件可能已损坏）`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const entryCrc = buffer.readUInt32LE(cursor + 16);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttr = buffer.readUInt32LE(cursor + 38);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLen;
    const commentStart = extraStart + extraLen;
    if (commentStart + commentLen > len) {
      throw new Error(`ZIP 结构异常：第 ${i + 1} 个中央目录条目的字段越界（文件可能被截断）`);
    }
    const raw = {
      size: buffer.readUInt32LE(cursor + 24),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      offset: buffer.readUInt32LE(cursor + 42),
      diskStart,
    };
    const fixed =
      raw.size === 0xffffffff ||
      raw.compressedSize === 0xffffffff ||
      raw.offset === 0xffffffff ||
      raw.diskStart === 0xffff;
    const info = fixed
      ? applyZip64Extra(buffer.subarray(extraStart, commentStart), raw)
      : { ...raw, isZip64: false };

    if (info.diskStart !== 0) throw new Error('暂不支持分卷（多磁盘）ZIP 文件');

    const name = normalizeEntryName(decodeEntryName(buffer.subarray(nameStart, extraStart), flags));
    const isDirectory = name.endsWith('/') || (externalAttr & 0x10) !== 0;
    if (entries.has(name)) {
      throw new Error(`ZIP 结构异常：存在重复条目名 "${name}"`);
    }
    entries.set(name, {
      name,
      size: info.size,
      compressedSize: info.compressedSize,
      method,
      crc32: entryCrc,
      isDirectory,
      flags,
      localHeaderOffset: info.offset,
      zip64: info.isZip64 || needZip64,
    });
    cursor = commentStart + commentLen;
  }

  /** 已解压缓存，避免重复解压与重复校验 */
  const cache = new Map();

  /**
   * 宽松查找条目：支持开头斜杠差异、反斜杠、目录名带结尾斜杠、大小写差异
   * @param {string} name 条目名
   * @returns {object|null}
   */
  function lookup(name) {
    if (typeof name !== 'string' || name === '') {
      throw new Error('ZIP 条目名必须是非空字符串');
    }
    if (entries.has(name)) return entries.get(name);
    const candidates = [
      name.replace(/^\/+/, ''),
      `/${name}`,
      name.replace(/\\/g, '/'),
      `${name}/`,
      name.replace(/\/+$/, ''),
    ];
    for (const candidate of candidates) {
      if (candidate && entries.has(candidate)) return entries.get(candidate);
    }
    const lower = name.toLowerCase();
    for (const [key, value] of entries) {
      if (key.toLowerCase() === lower) return value;
    }
    return null;
  }

  /**
   * 解压并返回条目内容（含 CRC32 与大小校验）；不存在或损坏时抛中文错误
   * @param {string} name 条目名
   * @returns {Buffer} 解压后的内容
   */
  function read(name) {
    const entry = lookup(name);
    if (!entry) throw new Error(`ZIP 中不存在条目："${name}"`);
    if (cache.has(entry.name)) return cache.get(entry.name);
    if (entry.flags & 0x1) {
      throw new Error(
        `ZIP 条目 "${entry.name}" 已加密（通用位 bit 0 置位），暂不支持加密的 ZIP：请先取消密码保护再上传`,
      );
    }
    if (entry.isDirectory) {
      const empty = Buffer.alloc(0);
      cache.set(entry.name, empty);
      return empty;
    }
    const headerPos = base + entry.localHeaderOffset;
    if (entry.localHeaderOffset < 0 || headerPos < 0 || headerPos + 30 > len) {
      throw new Error(`ZIP 条目 "${entry.name}" 的本地文件头偏移越界（文件可能已损坏）`);
    }
    if (buffer.readUInt32LE(headerPos) !== SIG_LOCAL_FILE) {
      throw new Error(`ZIP 条目 "${entry.name}" 的本地文件头签名错误（文件可能已损坏）`);
    }
    const nameLen = buffer.readUInt16LE(headerPos + 26);
    const extraLen = buffer.readUInt16LE(headerPos + 28);
    const dataStart = headerPos + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < 0 || dataEnd > len) {
      throw new Error(
        `ZIP 条目 "${entry.name}" 的数据越界：声明的压缩大小为 ${entry.compressedSize} 字节，超出文件范围`,
      );
    }
    const rawData = buffer.subarray(dataStart, dataEnd);

    let output;
    if (entry.method === 0) {
      output = Buffer.from(rawData);
    } else if (entry.method === 8) {
      if (entry.size > maxEntrySize) {
        throw new Error(
          `ZIP 条目 "${entry.name}" 声明解压后大小为 ${entry.size} 字节，超过安全上限 ${maxEntrySize} 字节`,
        );
      }
      try {
        output = inflateRawSync(rawData);
      } catch (err) {
        throw new Error(`ZIP 条目 "${entry.name}" 解压失败：deflate 数据已损坏（${err.message}）`);
      }
    } else {
      throw new Error(
        `ZIP 条目 "${entry.name}" 使用了不支持的压缩方式（method=${entry.method}），仅支持 0（stored）与 8（deflate）`,
      );
    }

    if (output.length > maxEntrySize) {
      throw new Error(
        `ZIP 条目 "${entry.name}" 解压后大小为 ${output.length} 字节，超过安全上限 ${maxEntrySize} 字节`,
      );
    }
    if (output.length !== entry.size) {
      throw new Error(
        `ZIP 条目 "${entry.name}" 大小校验失败：头部声明 ${entry.size} 字节，实际解压 ${output.length} 字节`,
      );
    }
    const actualCrc = crc32(output);
    if (actualCrc !== entry.crc32) {
      const expected = entry.crc32.toString(16).padStart(8, '0');
      const actual = actualCrc.toString(16).padStart(8, '0');
      throw new Error(
        `ZIP 条目 "${entry.name}" CRC32 校验失败：期望 0x${expected}，实际 0x${actual}（数据已损坏）`,
      );
    }
    cache.set(entry.name, output);
    return output;
  }

  /**
   * 读取并解码文本条目
   * @param {string} name 条目名
   * @returns {string} UTF-8 文本（已去除可能的 BOM）
   */
  function readText(name) {
    return read(name).toString('utf8').replace(/^\uFEFF/, '');
  }

  /**
   * 判断条目是否存在
   * @param {string} name 条目名
   * @returns {boolean}
   */
  function has(name) {
    if (typeof name !== 'string' || name === '') return false;
    try {
      return lookup(name) !== null;
    } catch {
      return false;
    }
  }

  /**
   * 列出全部条目名（中央目录顺序）
   * @returns {string[]}
   */
  function list() {
    return [...entries.keys()];
  }

  return { entries, read, readText, has, list };
}

/**
 * 便捷函数：一次性解压全部条目（跳过目录项）
 * @param {Buffer|Uint8Array} buffer zip 数据
 * @returns {Map<string, Buffer>} 条目名 -> 内容
 */
export function unzip(buffer) {
  const zip = readZip(buffer);
  const result = new Map();
  for (const [name, entry] of zip.entries) {
    if (entry.isDirectory) continue;
    result.set(name, zip.read(name));
  }
  return result;
}
