/**
 * 系统里的中文字体。
 *
 * 为什么要有这个文件：PPT 转 PDF 是**用服务器上装了的字体**来画字的。
 * 云服务器的精简镜像里几乎不带任何中文字体，于是转出来的 PDF 里中文
 * 会变成方框或者乱码 —— 而文件本身是好的、转换也「成功」了，
 * 所以没有任何报错，只有人眼能看出来。
 *
 * 这是「纯文本环境」和「桌面环境」的经典差异：在 Windows / macOS 上
 * 永远遇不到（系统自带中文字体），一到 Linux 服务器就冒出来。
 */

import { execSync } from 'node:child_process';

let cached;

/** 清掉缓存（测试用） */
export function resetFontCache() {
  cached = undefined;
}

/**
 * 从 `fc-list :lang=zh family` 的输出里解析出字体族名。
 *
 * 抽成纯函数是为了能直接测：真实环境要验「装了字体」这一格，
 * 而这一格没法在测试里靠装字体来复现。
 *
 * fc-list 的每一行是一个字体，同族的不同语言名之间用逗号分隔，例如：
 *   Noto Sans CJK SC
 *   WenQuanYi Micro Hei,WenQuanYi Micro Hei Mono,文泉驿微米黑
 *
 * @returns {string[]} 去重后的族名
 */
export function parseCjkFontFamilies(output) {
  return [...new Set(
    String(output || '')
      .split('\n')
      .flatMap((line) => line.split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  )];
}

/**
 * 系统里有没有能显示中文的字体。
 *
 * @returns {{ok:boolean, skipped:boolean, reason:string, families:string[]}}
 *   ok      有中文字体（或者这个平台不需要查）
 *   skipped 这台机器不用查（非 Linux 系统自带中文字体）
 *   reason  'ok' | 'not-linux' | 'no-cjk-font' | 'fc-list-unavailable'
 */
export function cjkFontStatus() {
  if (cached) return cached;

  // Windows / macOS 自带中文字体，不用查也不该报警
  if (process.platform !== 'linux') {
    cached = { ok: true, skipped: true, reason: 'not-linux', families: [] };
    return cached;
  }

  let out = '';
  try {
    // :lang=zh 让 fontconfig 只列出覆盖中文的字体，不用我们自己猜哪个能显示中文
    out = execSync('fc-list :lang=zh family', {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
  } catch (err) {
    // fc-list 都不在（fontconfig 没装）—— 这同样是「没有中文字体」，
    // 而且这种情况下 LibreOffice 也画不出中文，所以按缺字体处理
    cached = {
      ok: false,
      skipped: false,
      reason: 'fc-list-unavailable',
      families: [],
      detail: err.message,
    };
    return cached;
  }

  const families = parseCjkFontFamilies(out);
  cached = families.length
    ? { ok: true, skipped: false, reason: 'ok', families }
    : { ok: false, skipped: false, reason: 'no-cjk-font', families: [] };
  return cached;
}

/**
 * 装中文字体的命令（给用户复制的）。
 *
 * 只放**确定存在于 Ubuntu / Debian 仓库**的包名：一条 apt 命令里只要有一个
 * 包名不存在，整条命令就全都不装 —— 那种失败方式比缺字体更难查。
 * 想要宋体更像原件，可以另外单独补 `fonts-noto-cjk-extra`。
 */
export const CJK_FONT_INSTALL_HINT =
  'sudo apt install -y fonts-noto-cjk fonts-wqy-microhei fonts-wqy-zenhei';
