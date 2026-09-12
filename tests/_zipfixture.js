/**
 * 测试专用的最小 ZIP 打包器（零第三方依赖）
 *
 * 只在测试里使用：用「自己写的写」来验证「自己写的读」。
 * 支持 stored（method 0，默认）与 deflate（method 8）、目录项、
 * 前置垃圾数据、EOCD 注释、ZIP64（EOCD64 + locator）以及 ZIP64 条目扩展字段，
 * 也允许故意写入错误的 CRC / 大小，用于验证读取器的防御性校验。
 */

import { deflateRawSync } from 'node:zlib';

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_FILE = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;

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
 * 计算 CRC32（与 src/lib/zip.js 独立实现，避免「同源错误」掩盖问题）
 * @param {Buffer|Uint8Array} buffer 数据
 * @returns {number}
 */
export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = (CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return ~c >>> 0;
}

/**
 * 把字符串 / Buffer / Uint8Array 统一转成 Buffer
 * @param {string|Buffer|Uint8Array} value 输入
 * @returns {Buffer}
 */
export function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value), 'utf8');
}

/**
 * 构造一个最小的 zip 文件
 * @param {Array<{
 *   name: string, data?: string|Buffer|Uint8Array, method?: 'store'|'deflate', dir?: boolean,
 *   nameBytes?: Buffer, flags?: number, crc32?: number, size?: number, compressedSize?: number,
 *   headerMethod?: number, zeroLocalSizes?: boolean, extraData?: Buffer, extraId?: number
 * }>} entries 条目列表
 * @param {{ prefix?: string|Buffer, comment?: string, zip64?: boolean, zip64Entries?: boolean }} [options]
 *   prefix：在 zip 之前拼接的其它数据；zip64：写 EOCD64 + locator；
 *   zip64Entries：条目头部使用 0xFFFFFFFF + ZIP64 扩展字段
 * @returns {Buffer} zip 文件内容
 */
export function buildZip(entries, options = {}) {
  const prefix = toBuffer(options.prefix);
  const useZip64Eocd = options.zip64 === true;
  const useZip64Entries = options.zip64Entries === true;

  const localChunks = [];
  const centralChunks = [];
  let relative = 0; // 相对 zip 起点的偏移（不含 prefix）

  for (const spec of entries) {
    const name = String(spec.name);
    const nameBytes = spec.nameBytes ? toBuffer(spec.nameBytes) : Buffer.from(name, 'utf8');
    const isDirectory = spec.dir === true || name.endsWith('/');
    const data = isDirectory ? Buffer.alloc(0) : toBuffer(spec.data);
    // 实际压缩方式由 method 决定；headerMethod 只改头部里写的压缩方式（用于构造异常样本）
    const method = spec.method === 'deflate' ? 8 : 0;
    const headerMethod = spec.headerMethod ?? method;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = spec.crc32 ?? crc32(data);
    const size = spec.size ?? data.length;
    const compressedSize = spec.compressedSize ?? compressed.length;
    const flags =
      spec.flags ??
      (/^[\x20-\x7e]*$/.test(name) || spec.nameBytes ? 0 : 0x800);
    // 流式写入方会把「大小 / CRC 写在数据描述符里」的通用位（bit 3）同时写进本地头与中央目录；
    // 加密标记（bit 0）同样两边都写
    const effectiveFlags =
      (spec.zeroLocalSizes ? flags | 0x8 : flags) | (spec.encrypted ? 0x1 : 0);

    // 本地文件头扩展字段：ZIP64 时写真实大小；extraData 可写入其它扩展字段（如时间戳）
    const extraFields = [];
    if (useZip64Entries) extraFields.push(buildZip64Extra({ size, compressedSize }));
    if (spec.extraData) {
      const payload = toBuffer(spec.extraData);
      const extra = Buffer.alloc(4 + payload.length);
      extra.writeUInt16LE(spec.extraId ?? 0x5455, 0);
      extra.writeUInt16LE(payload.length, 2);
      payload.copy(extra, 4);
      extraFields.push(extra);
    }
    const localExtra = Buffer.concat(extraFields);
    // 流式写入方（Java / .NET ZipArchive 流模式等）会在本地头里把大小写成 0，靠中央目录给出真实值
    const localCompressedSize = spec.zeroLocalSizes
      ? 0
      : useZip64Entries
        ? 0xffffffff
        : compressedSize;
    const localSize = spec.zeroLocalSizes ? 0 : useZip64Entries ? 0xffffffff : size;
    const localHeader = Buffer.alloc(30 + nameBytes.length + localExtra.length);
    localHeader.writeUInt32LE(SIG_LOCAL_FILE, 0);
    localHeader.writeUInt16LE(useZip64Entries ? 45 : 20, 4);
    localHeader.writeUInt16LE(effectiveFlags, 6);
    localHeader.writeUInt16LE(headerMethod, 8);
    localHeader.writeUInt16LE(0, 10); // 时间
    localHeader.writeUInt16LE(0x21, 12); // 日期（1980-01-01）
    localHeader.writeUInt32LE(spec.zeroLocalSizes ? 0 : crc, 14);
    localHeader.writeUInt32LE(localCompressedSize, 18);
    localHeader.writeUInt32LE(localSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(localExtra.length, 28);
    nameBytes.copy(localHeader, 30);
    localExtra.copy(localHeader, 30 + nameBytes.length);

    const localOffset = relative;
    localChunks.push(localHeader, compressed);
    relative += localHeader.length + compressed.length;

    const centralExtraFields = [];
    if (useZip64Entries) {
      centralExtraFields.push(buildZip64Extra({ size, compressedSize, offset: localOffset }));
    }
    if (spec.extraData) {
      const payload = toBuffer(spec.extraData);
      const extra = Buffer.alloc(4 + payload.length);
      extra.writeUInt16LE(spec.extraId ?? 0x5455, 0);
      extra.writeUInt16LE(payload.length, 2);
      payload.copy(extra, 4);
      centralExtraFields.push(extra);
    }
    const centralExtra = Buffer.concat(centralExtraFields);
    const central = Buffer.alloc(46 + nameBytes.length + centralExtra.length);
    central.writeUInt32LE(SIG_CENTRAL_FILE, 0);
    central.writeUInt16LE(0x031e, 4); // version made by（UNIX / 3.0）
    central.writeUInt16LE(useZip64Entries ? 45 : 20, 6);
    central.writeUInt16LE(effectiveFlags, 8);
    central.writeUInt16LE(headerMethod, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(useZip64Entries ? 0xffffffff : compressedSize, 20);
    central.writeUInt32LE(useZip64Entries ? 0xffffffff : size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt16LE(0, 32); // 注释长度
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(isDirectory ? 0x10 : 0, 38); // 外部属性
    central.writeUInt32LE(useZip64Entries ? 0xffffffff : localOffset, 42);
    nameBytes.copy(central, 46);
    centralExtra.copy(central, 46 + nameBytes.length);
    centralChunks.push(central);
  }

  const centralBuffer = Buffer.concat(centralChunks);
  const cdOffset = relative;
  const cdSize = centralBuffer.length;
  const count = entries.length;

  const tailChunks = [];
  if (useZip64Eocd) {
    const zip64Record = Buffer.alloc(56);
    zip64Record.writeUInt32LE(SIG_ZIP64_EOCD, 0);
    zip64Record.writeBigUInt64LE(44n, 4); // 记录长度（不含前 12 字节）
    zip64Record.writeUInt16LE(45, 12);
    zip64Record.writeUInt16LE(45, 14);
    zip64Record.writeUInt32LE(0, 16);
    zip64Record.writeUInt32LE(0, 20);
    zip64Record.writeBigUInt64LE(BigInt(count), 24);
    zip64Record.writeBigUInt64LE(BigInt(count), 32);
    zip64Record.writeBigUInt64LE(BigInt(cdSize), 40);
    zip64Record.writeBigUInt64LE(BigInt(cdOffset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    tailChunks.push(zip64Record, locator);
  }

  const comment = toBuffer(options.comment);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(useZip64Eocd ? 0xffff : count, 8);
  eocd.writeUInt16LE(useZip64Eocd ? 0xffff : count, 10);
  eocd.writeUInt32LE(useZip64Eocd ? 0xffffffff : cdSize, 12);
  eocd.writeUInt32LE(useZip64Eocd ? 0xffffffff : cdOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);
  tailChunks.push(eocd);

  return Buffer.concat([prefix, ...localChunks, centralBuffer, ...tailChunks]);
}

/**
 * 构造 ZIP64 扩展字段（0x0001），按 ZIP 规范顺序写入 size / compressedSize / offset
 * @param {{ size: number, compressedSize: number, offset?: number }} values 字段值
 * @returns {Buffer}
 */
function buildZip64Extra(values) {
  const parts = [BigInt(values.size), BigInt(values.compressedSize)];
  if (values.offset !== undefined) parts.push(BigInt(values.offset));
  const payload = Buffer.alloc(parts.length * 8);
  parts.forEach((value, index) => payload.writeBigUInt64LE(value, index * 8));
  const extra = Buffer.alloc(4 + payload.length);
  extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  extra.writeUInt16LE(payload.length, 2);
  payload.copy(extra, 4);
  return extra;
}
