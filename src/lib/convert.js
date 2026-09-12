/**
 * Office 文档 → PDF 转换。
 *
 * 为什么需要它：浏览器不能直接渲染 .pptx。老师发的课件大多是 PPT，
 * 要「点开就能看」必须先把 PPT 转成 PDF，再用浏览器内置的 PDF 阅读器显示。
 *
 * 转换器按优先级自动探测（全部是调用本机已装的软件，不需要联网服务）：
 *   1. LibreOffice (soffice)  —— 跨平台，开源，首选
 *   2. Microsoft PowerPoint / Word / Excel (COM 自动化) —— Windows
 *   3. WPS Office (KWPP/KWPS/KET Application) —— Windows 常见
 * 三者都没有时，上层会退化为「网页版文本预览」。
 */

import { spawn, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import config, { ensureRuntimeDirs } from '../config.js';

/** 缓存探测结果，避免每次转换都扫一遍磁盘 */
let cachedConverter = undefined;

/** 能导出成图片的扩展名（只有幻灯片有意义，Word/Excel 没这一说） */
const PPT_EXTS = ['.ppt', '.pptx', '.pps', '.ppsx'];

const WINDOWS_CANDIDATES = {
  libreoffice: [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files\\LibreOffice 7\\program\\soffice.exe',
  ],
  wps: [
    `${process.env.LOCALAPPDATA}\\Kingsoft\\WPS Office\\ksolaunch.exe`,
    'C:\\Program Files\\WPS Office\\office6\\wpp.exe',
    'C:\\Program Files (x86)\\WPS Office\\office6\\wpp.exe',
  ],
};

/** 检查路径是否为可执行文件 */
function isExecutable(p) {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 在 PATH 里找可执行文件 */
function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

/**
 * 探测可用的转换器。
 * @returns {{type:'libreoffice'|'powerpoint'|'wps', path:string|null, label:string}|null}
 */
export function detectConverter() {
  if (cachedConverter !== undefined) return cachedConverter;

  // 1. 显式配置优先
  if (config.soforcePath && isExecutable(config.soforcePath)) {
    cachedConverter = { type: 'libreoffice', path: config.soforcePath, label: 'LibreOffice（手动配置）' };
    return cachedConverter;
  }

  // 2. PATH 里的 soffice（Linux/macOS 常见）
  const sofficeOnPath = which('soffice') || which('libreoffice');
  if (sofficeOnPath) {
    cachedConverter = { type: 'libreoffice', path: sofficeOnPath, label: 'LibreOffice' };
    return cachedConverter;
  }

  // 3. Windows 常见安装位置
  if (process.platform === 'win32') {
    for (const p of WINDOWS_CANDIDATES.libreoffice) {
      if (isExecutable(p)) {
        cachedConverter = { type: 'libreoffice', path: p, label: 'LibreOffice' };
        return cachedConverter;
      }
    }

    // Microsoft Office：只要能找到 POWERPNT.EXE 就认为可用（COM 会自动找其它组件）
    const officeRoots = [
      'C:\\Program Files\\Microsoft Office\\root\\Office16',
      'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16',
      'C:\\Program Files\\Microsoft Office\\Office16',
      'C:\\Program Files (x86)\\Microsoft Office\\Office16',
      'C:\\Program Files\\Microsoft Office\\Office15',
    ];
    for (const root of officeRoots) {
      if (isExecutable(path.join(root, 'POWERPNT.EXE'))) {
        cachedConverter = {
          type: 'powerpoint',
          path: null,
          label: 'Microsoft Office（COM 自动化）',
        };
        return cachedConverter;
      }
    }

    // WPS
    for (const p of WINDOWS_CANDIDATES.wps) {
      if (isExecutable(p)) {
        cachedConverter = { type: 'wps', path: p, label: 'WPS Office（COM 自动化）' };
        return cachedConverter;
      }
    }
  }

  cachedConverter = null;
  return cachedConverter;
}

/** 重置探测缓存（设置页改配置后调用） */
export function resetConverterCache() {
  cachedConverter = undefined;
  cachedPowershell = undefined;
}

// ============================================================
// PowerShell 可用性探测（Windows COM 路线的前置条件）
// ============================================================

/**
 * Windows 状态码 → 人话。
 *
 * 这些数字是 NTSTATUS，直接甩给用户等于没说。
 * 特别注意 0xC0000142：它长得像「Office 没装好」，其实最常见的来源是
 * 我们自己传错了 spawn 参数（见 spawnToLog 上方的实测数据）。
 * 所以措辞上要指向「子进程没能初始化」，而不是暗示对方去重装 Office。
 */
function explainWinStatus(code) {
  switch (code >>> 0) {
    case 0xC0000142:
      return {
        name: 'STATUS_DLL_INIT_FAILED',
        text: '子进程没能完成初始化',
      };
    case 0xC0000135:
      return {
        name: 'STATUS_DLL_NOT_FOUND',
        text: '缺少依赖的动态库',
      };
    case 0xC0000005:
      return {
        name: 'STATUS_ACCESS_VIOLATION',
        text: '进程访问越界（多为安全软件拦截）',
      };
    default:
      return { name: '', text: '' };
  }
}

/** 把退出码写成 0x 开头的十六进制，方便搜索 */
function hexStatus(code) {
  if (typeof code !== 'number') return '';
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

let cachedPowershell;

/**
 * 实际启动一次 PowerShell，看它到底能不能跑。
 *
 * 为什么非测不可：COM 自动化是靠 `powershell.exe` 起进程去 New-Object 的。
 * detectConverter() 只在磁盘上找 POWERPNT.EXE，找到了就宣布「Office 可用」，
 * 但那只是「装了」，不等于「调得动」。
 *
 * 实测踩过的坑：Office 装得好好的、也没激活问题，可在受限环境里
 * powershell.exe 每次启动都返回 0xC0000142（STATUS_DLL_INIT_FAILED），
 * 所有转换注定失败——而设置页还在说「预览效果与原件一致」。
 * 用户看到的只是「上传了 PPT，预览却是纯文字」，完全无从下手。
 *
 * 用 spawnSync + stdio:'ignore'，靠退出码判断：
 * 受限环境常常不允许创建管道，收输出会连带失败。
 *
 * @returns {{ok:boolean, status:'ok'|'not-windows'|'not-found'|'blocked'|'failed',
 *            exitCode:number|null, hex:string, message:string}}
 */
export function probePowershell() {
  if (cachedPowershell !== undefined) return cachedPowershell;

  // 非 Windows 平台走的是 LibreOffice 路线，根本不需要 PowerShell
  if (process.platform !== 'win32') {
    cachedPowershell = {
      ok: true,
      status: 'not-windows',
      exitCode: null,
      hex: '',
      message: '非 Windows 平台，不需要 PowerShell',
    };
    return cachedPowershell;
  }

  let result = null;
  let said = '';

  try {
    fs.mkdirSync(config.cacheDir, { recursive: true });
    const logPath = path.join(config.cacheDir, `ps-probe-${crypto.randomBytes(4).toString('hex')}.log`);

    // ⚠️ stdio 必须用文件描述符，不能用 'ignore'。
    // 见 spawnToLog 上方的实测数据：'ignore' + windowsHide 会让子进程
    // 以 0xC0000142 挂掉，于是把「好端端的 PowerShell」误报成「环境不允许」——
    // 我第一次就是这么误判的，差点让用户去换个环境跑，白折腾。
    const fd = fs.openSync(logPath, 'a');
    try {
      result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0'],
        { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 20_000 },
      );
    } finally {
      try { fs.closeSync(fd); } catch { /* 已经关了 */ }
    }
    said = readLog(logPath);
    fsp.rm(logPath, { force: true }).catch(() => {});
  } catch (err) {
    cachedPowershell = {
      ok: false,
      status: 'not-found',
      exitCode: null,
      hex: '',
      message: `无法启动 PowerShell：${err.message}`,
    };
    return cachedPowershell;
  }

  if (result.error) {
    // spawn 层面的失败：找不到可执行文件之类
    const notFound = result.error.code === 'ENOENT';
    cachedPowershell = {
      ok: false,
      status: notFound ? 'not-found' : 'failed',
      exitCode: null,
      hex: '',
      message: notFound
        ? '找不到 powershell.exe'
        : `无法启动 PowerShell：${result.error.message}`,
    };
    return cachedPowershell;
  }

  if (result.status === 0) {
    cachedPowershell = {
      ok: true,
      status: 'ok',
      exitCode: 0,
      hex: '0x00000000',
      message: 'PowerShell 可用',
    };
    return cachedPowershell;
  }

  const hex = hexStatus(result.status);
  const info = explainWinStatus(result.status);

  cachedPowershell = {
    ok: false,
    status: 'failed',
    exitCode: result.status,
    hex,
    message: `PowerShell 启动失败（退出码 ${result.status}${hex ? ` / ${hex}` : ''}`
      + `${info.name ? ` ${info.name}` : ''}）${info.text ? `：${info.text}` : ''}`
      + `${said ? ` PowerShell 说：${said.slice(0, 200)}` : ''}`,
  };
  return cachedPowershell;
}

/**
 * 转换器「到底能不能真的用」。
 *
 * 与 detectConverter() 的分工：
 *   detectConverter()     只看磁盘上装没装（纯静态，不做任何进程操作）
 *   converterReadiness()  还会验证调用链跑得起来
 *
 * 页面和转换流程都应该看这个，而不是 detectConverter()。
 */
export function converterReadiness() {
  const converter = detectConverter();
  if (!converter) {
    return { available: false, converter: null, reason: 'not-installed', powershell: null };
  }

  // LibreOffice 是直接起进程的，不走 COM，不需要 PowerShell
  if (converter.type === 'libreoffice') {
    return { available: true, converter, reason: 'ok', powershell: null };
  }

  const ps = probePowershell();
  if (!ps.ok) {
    return { available: false, converter, reason: 'powershell-unavailable', powershell: ps };
  }
  return { available: true, converter, reason: 'ok', powershell: ps };
}


/**
 * 转换主入口。
 *
 * @param {string} inputPath 源文件绝对路径
 * @param {string} ext 源文件扩展名（含点，小写）
 * @returns {Promise<{ok:boolean, pdfPath?:string, error?:string, converter?:string}>}
 */
export async function convertToPdf(inputPath, ext) {
  if (!config.enableOfficeConvert) {
    return { ok: false, error: 'Office 转 PDF 功能已在配置中关闭' };
  }

  const ready = converterReadiness();
  const converter = ready.converter;

  if (!ready.available) {
    // 装了转换器但调不动，和「压根没装」是两回事，要给不同的提示
    if (ready.reason === 'powershell-unavailable') {
      return {
        ok: false,
        error:
          `检测到 ${converter.label}，但它需要靠 PowerShell 调用 COM 组件，而${ready.powershell.message}。`
          + '课件没有丢，当前显示的是内置解析器抽出来的文字版预览（没有排版）。',
        converter: converter.label,
      };
    }
    return { ok: false, error: '未检测到 LibreOffice / Office / WPS，无法转换为 PDF' };
  }

  ensureRuntimeDirs();
  const outDir = path.join(config.cacheDir, 'pdf');
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(outDir, `${baseName}.pdf`);

  // 已转换过就直接复用（同一份文件内容不变，文件名是随机 ID，不会撞车）
  if (fileExistsNonEmpty(outputPath)) {
    return { ok: true, pdfPath: outputPath, converter: converter.label };
  }

  try {
    if (converter.type === 'libreoffice') {
      await convertWithLibreOffice(converter.path, inputPath, outDir);
      // LibreOffice 会把输出命名为「源文件主名.pdf」，但源文件名带随机 ID，
      // 所以需要重命名成我们期望的输出路径
      const produced = path.join(outDir, `${baseName}.pdf`);
      if (produced !== outputPath && fileExistsNonEmpty(produced)) {
        await fsp.rename(produced, outputPath);
      }
    } else {
      await convertWithCom(converter.type, inputPath, outputPath, ext);
    }
  } catch (err) {
    // ⚠️ 脚本报错 ≠ 没转成功。
    //
    // 实测过这种情况：PDF 已经完整写出来了（1.2 MB，%PDF-1.7 文件头正常），
    // 但随后 $doc.Close() / $app.Quit() 阶段 PowerPoint 自己崩了，
    // 于是脚本在写 'OK' 之前就抛了异常，我们也跟着报失败 ——
    // 用户看到「转换失败」，可 PDF 明明就躺在那里。
    //
    // 所以这里不急着返回失败，先看产物在不在。
    if (!fileExistsNonEmpty(outputPath)) {
      return { ok: false, error: err.message, converter: converter.label };
    }
    return {
      ok: true,
      pdfPath: outputPath,
      converter: converter.label,
      // 留个痕迹：这次转换其实是「带着错误成功的」，方便以后排查
      note: `转换成功，但收尾时报了错：${err.message}`,
    };
  }

  if (!fileExistsNonEmpty(outputPath)) {
    return { ok: false, error: '转换命令已执行但没有生成 PDF 文件', converter: converter.label };
  }

  // 转换成功了，顺手打扫一下 Office 留下的临时文件
  sweepOfficeTemp(outDir);

  return { ok: true, pdfPath: outputPath, converter: converter.label };
}

function fileExistsNonEmpty(p) {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

// ============================================================
// 起子进程（含那个「stdio:'ignore' + windowsHide」的坑）
// ============================================================

/**
 * 起一个子进程，把它的输出重定向到日志文件。
 *
 * ⚠️ 这里的 stdio 写法是踩出来的，不要「简化」成 `stdio: 'ignore'`。
 *
 * 实测数据（同一个 exe、同一台机器，各跑 3~5 次，结论稳定）：
 *
 *   stdio:'ignore' + windowsHide:true          → 0xC0000142（子进程起不来）
 *   stdio:['ignore', fd, fd] + windowsHide     → 正常
 *   stdio:'inherit' + windowsHide              → 正常
 *   stdio:'ignore'（不设 windowsHide）          → 正常
 *
 * 也就是说：**把三条流全接到 NUL 上、同时又要求隐藏窗口**，
 * 子进程就会以 STATUS_DLL_INIT_FAILED 挂掉。
 *
 * 这个坑的危害在于报错信息极具误导性：退出码 0xC0000142 看起来像
 * 「Office 没装好 / 没激活」，于是会去重装 Office，白折腾一场。
 * 实际上 PowerShell、cmd、node 全都好得很，只是我们传的参数不对。
 *
 * 用真实文件描述符接管输出是最优解：不弹黑框、不刷屏，
 * 而且子进程说了什么都能读回来（排查问题时这一步很关键）。
 *
 * @returns {Promise<number|null>} 子进程退出码
 */
function spawnToLog(exe, args, { logPath, timeoutMs, timeoutMessage } = {}) {
  let fd = null;
  try {
    if (logPath) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fd = fs.openSync(logPath, 'a');
    }
  } catch {
    fd = null;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      // 能开日志就用日志接输出；开不了就退回 inherit（也是实测可用的组合），
      // 无论如何都不要用 'ignore' + windowsHide 那个坏组合
      stdio: fd === null ? 'inherit' : ['ignore', fd, fd],
      windowsHide: true,
    });

    const closeFd = () => {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* 已经关了 */ }
        fd = null;
      }
    };

    const timer = setTimeout(() => {
      child.kill();
      closeFd();
      reject(new Error(timeoutMessage || `子进程超时（${Math.round((timeoutMs || 0) / 1000)} 秒）`));
    }, timeoutMs || 120_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      closeFd();
      reject(new Error(`无法启动 ${path.basename(exe)}：${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      closeFd();
      resolve(code);
    });
  });
}

/** 读日志文件，读不到就返回空串 */
function readLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8').replace(/^\ufeff/, '').trim();
  } catch {
    return '';
  }
}

/**
 * 清理 Office 转换留下的临时文件。
 *
 * PowerPoint 的 SaveAs 会在输出目录里丢下 msoXXXX.tmp，转一次留一对，
 * 时间久了缓存目录会越来越乱。这些文件我们完全用不上。
 *
 * 只删「10 分钟没动过」的：转换可能有两个进程并行，
 * 太新的文件说不定正被 PowerPoint 占着，删了会出问题。
 * 删不掉就算了 —— 这只是打扫卫生，不该影响任何主流程。
 */
export function sweepOfficeTemp(dir, cutoffMs = 10 * 60 * 1000) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!/^mso.*\.tmp$/i.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs < cutoffMs) continue;
      fs.rmSync(full, { force: true });
      removed += 1;
    } catch {
      /* 正在被占用就下次再说 */
    }
  }
  return removed;
}

// ============================================================
// LibreOffice
// ============================================================

function convertWithLibreOffice(soffice, inputPath, outDir) {
  // -env:UserInstallation 指定独立的用户配置目录。
  // 不指定的话，当 LibreOffice 已经开着时 headless 转换会静默失败。
  // 放在 cache 目录而不是系统临时目录，避免临时目录权限受限导致启动失败。
  const profileDir = path.join(config.cacheDir, `lo-profile-${crypto.randomBytes(4).toString('hex')}`);
  const args = [
    `-env:UserInstallation=file:///${profileDir.replace(/\\/g, '/')}`,
    '--headless',
    '--norestore',
    '--invisible',
    '--convert-to',
    'pdf:impress_pdf_Export',
    '--outdir',
    outDir,
    inputPath,
  ];

  // LibreOffice 的输出对排查帮助有限，成败以「PDF 是否真的生成」为准，
  // 但输出还是留一份日志，免得真出问题时两眼一抹黑
  const logPath = path.join(config.cacheDir, `lo-${crypto.randomBytes(4).toString('hex')}.log`);

  return spawnToLog(soffice, args, {
    logPath,
    timeoutMs: 120_000,
    timeoutMessage: 'LibreOffice 转换超时（120 秒）',
  })
    .then((code) => {
      // LibreOffice 有时返回非 0 但实际转换成功，所以退出码只当参考
      void code;
    })
    .finally(() => {
      fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      fsp.rm(logPath, { force: true }).catch(() => {});
    });
}

// ============================================================
// Windows COM 自动化（PowerPoint / Word / Excel / WPS）
// ============================================================

/**
 * 用 PowerShell 调用 COM 组件转换。
 *
 * 为什么走 PowerShell 而不是 Node 的 COM 绑定：
 * Node 没有内置 COM 支持，用 winax 这类模块就破坏了零依赖；
 * 而 Windows 自带 PowerShell，可以直接 New-Object -ComObject。
 *
 * 几个关键实现细节（每一条都是踩出来的）：
 *
 * 1. **用 -EncodedCommand 而不是 -File**。
 *    把脚本写成 .ps1 文件再用 -File 执行有两个坑：
 *      - Windows PowerShell 5.1 对**没有 BOM** 的 .ps1 按 ANSI 解码，
 *        脚本里的中文（课件路径、课程名）会变成乱码，导致转换莫名其妙失败；
 *      - 临时目录在某些环境下不可写或被安全软件盯着。
 *    -EncodedCommand 接收 UTF-16LE 的 base64，完全绕开这两个问题，
 *    也不用创建和清理临时脚本文件。
 *
 * 2. **路径必须绝对**。PowerPoint / Word / Excel 是按**它们自己的**工作目录
 *    解析相对路径的，传相对路径会报「找不到文件」，跟我们的 cwd 无关。
 *
 * 3. **不要用 stdio:'ignore' + windowsHide 起进程**，见 spawnToLog 的说明。
 *
 * 4. **PowerPoint 的枚举参数要用整数**（MsoTriState：msoTrue=-1 / msoFalse=0），
 *    传 $true/$false 轻则被吞、重则直接报「打不开文件」。详见 buildComScript。
 *
 * 5. **不加 -NonInteractive**。
 *    Office 的 COM 自动化需要在能够创建 GUI 对象的会话里运行。
 *    脚本本身自带 try/catch 和 $ErrorActionPreference='Stop'，不依赖交互式提示，
 *    所以去掉这个参数没有副作用，反而少一层限制。
 *
 * 失败时不会让上传失败：materials.js 会退回到「抽取文本 + 网页版预览」。
 */
async function convertWithCom(converterType, inputPath, outputPath, ext) {
  const logPath = `${outputPath}.convert.log`;
  const script = buildComScript(converterType, inputPath, outputPath, ext, logPath);

  // PowerShell 的 -EncodedCommand 要求 UTF-16LE 编码后再 base64
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  // 子进程自己的输出单独收一份，和脚本写的「结果日志」分开：
  // 脚本没能跑到写日志那一步时，这份就是唯一的线索
  const consoleLog = `${outputPath}.ps.log`;

  let exitCode = null;
  try {
    exitCode = await spawnToLog(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        logPath: consoleLog,
        timeoutMs: 150_000,
        timeoutMessage: 'Office 转换超时（150 秒）。可能是 Office 冷启动很慢，或者弹出了对话框在等待确认。',
      },
    );

    // 读脚本写的结果日志判断成败。
    // 日志是多行的：先是若干 STEP 进度，最后一行才是结论。
    const logLines = readLog(logPath).split('\n').map((l) => l.trim()).filter(Boolean);
    const verdict = logLines.find((l) => l.startsWith('OK') || l.startsWith('FAIL')) || '';

    if (verdict === 'OK') return;

    if (verdict.startsWith('FAIL')) {
      // 脚本自己已经写清了失败原因和最后成功的步骤，直接带给用户
      throw new Error(logLines.filter((l) => !l.startsWith('STEP')).join('；'));
    }

    // 脚本连结论都没写出来 —— 说明 PowerShell 自己没能正常跑完
    const psSaid = readLog(consoleLog);
    const hex = hexStatus(exitCode);
    const info = explainWinStatus(exitCode);

    throw new Error(
      `调用 Office 失败（PowerShell 退出码 ${exitCode}${hex ? ` / ${hex}` : ''}`
      + `${info.name ? ` ${info.name}` : ''}）。常见原因：`
      + '本机没装 Microsoft Office / WPS 桌面版；Office 尚未完成首次激活；'
      + '或者 Office 弹出了对话框在等待确认（例如文件被占用）。'
      + `${psSaid ? ` PowerShell 说：${psSaid.slice(0, 400)}` : ''}`
      + '课件数据没有丢失，预览已自动降级为网页版（只显示文字与结构，不带排版）。',
    );
  } finally {
    fsp.rm(logPath, { force: true }).catch(() => {});
    fsp.rm(consoleLog, { force: true }).catch(() => {});
  }
}

function psQuote(value) {
  // PowerShell 单引号字符串里，单引号需要写成两个
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildComScript(converterType, inputPath, outputPath, ext, logPath) {
  const In = psQuote(inputPath);
  const Out = psQuote(outputPath);
  const Log = psQuote(logPath);

  const isPpt = ['.ppt', '.pptx', '.pps', '.ppsx'].includes(ext);
  const isWord = ['.doc', '.docx', '.rtf'].includes(ext);
  const isExcel = ['.xls', '.xlsx'].includes(ext);

  // WPS 的 COM ProgID 与微软不同
  const progIds = converterType === 'wps'
    ? { ppt: 'KWPP.Application', word: 'KWPS.Application', excel: 'KET.Application' }
    : { ppt: 'PowerPoint.Application', word: 'Word.Application', excel: 'Excel.Application' };

  let body;
  if (isPpt) {
    body = `
  $app = New-Object -ComObject ${progIds.ppt}
  Note 'STEP app'
  # Visible 的类型是 MsoTriState 枚举，不是布尔值。
  # 写 $true 会抛 "Invalid cast from 'System.Boolean' to 'MsoTriState'"。
  # 原来的代码把它包在 try/catch 里，于是这个错被吞掉了，一直没人发现。
  # msoTrue = -1，msoFalse = 0。
  try { $app.Visible = -1 } catch { Note ("WARN Visible: " + $_.Exception.Message) }

  # ⚠️ 第四个参数 WithWindow 必须是 msoTrue(-1)。
  # 实测：传 msoFalse(0) 时 PowerPoint 直接报
  #   "PowerPoint could not open the file."（HRESULT 0x80004005）
  # 换成 msoTrue 立刻就打开成功（71 页的课件实测通过）。
  # PowerPoint 必须有窗口才能打开演示文稿 —— 原来传的是 $false，所以永远打不开。
  # 三个参数都要用整数，别用 $true/$false：它们期望的是 MsoTriState。
  $doc = $app.Presentations.Open(${In}, -1, 0, -1)
  Note 'STEP open'
  try {
    # 32 = ppSaveAsPDF
    $doc.SaveAs(${Out}, 32)
    Note 'STEP pdf'
  } finally {
    $doc.Close()
    $app.Quit()
  }`;
  } else if (isWord) {
    body = `
  $app = New-Object -ComObject ${progIds.word}
  try { $app.Visible = $false } catch {}
  try { $app.DisplayAlerts = 0 } catch {}
  $doc = $app.Documents.Open(${In}, $false, $true)
  try {
    # 17 = wdExportFormatPDF
    $doc.SaveAs2(${Out}, 17)
  } finally {
    $doc.Close(0)
    $app.Quit()
  }`;
  } else if (isExcel) {
    body = `
  $app = New-Object -ComObject ${progIds.excel}
  try { $app.Visible = $false } catch {}
  try { $app.DisplayAlerts = $false } catch {}
  $wb = $app.Workbooks.Open(${In}, 0, $true)
  try {
    # 0 = xlTypePDF
    $wb.ExportAsFixedFormat(0, ${Out})
  } finally {
    $wb.Close($false)
    $app.Quit()
  }`;
  } else {
    body = `
  throw "不支持的文件类型：${ext}"`;
  }

  return `$ErrorActionPreference = 'Stop'
$logFile = ${Log}
# 走到哪一步就记到哪一步：
# 出问题时能直接看出是「Office 起不来」「文件打不开」还是「导出 PDF 失败」，
# 而不是笼统的一句转换失败 —— 这三种情况的处理办法完全不同。
$lines = New-Object System.Collections.ArrayList
function Note($t) { [void]$lines.Add($t) }
try {
${body}
  if (Test-Path ${Out}) {
    Note 'OK'
  } else {
    Note 'FAIL 转换结束但没生成 PDF'
  }
} catch {
  Note ("FAIL " + $_.Exception.Message)
  try { Note ("HRESULT: 0x" + ('{0:X8}' -f $_.Exception.HResult)) } catch {}
  Note ("最后成功的步骤: " + $(if ($lines -contains 'STEP open') { '文件已打开' }
    elseif ($lines -contains 'STEP app') { 'Office 已启动' } else { '还没启动 Office' }))
}
# 统一在这里落盘。不能在 catch 里 exit，那样日志还没写就退出了，
# 我们就只剩一个退出码可看 —— 那正是排查最费劲的情况。
Set-Content -Path $logFile -Value $lines -Encoding UTF8
`;
}

// ============================================================
// 幻灯片 → 图片（PDF 导不出来时的另一条渲染路径）
// ============================================================

/**
 * 把 PPT 的每一页导出成 PNG。
 *
 * 为什么除了 PDF 之外还要这一条：
 * Office 导 PDF 走的是打印/XPS 管线，**需要一个可用的打印机**。
 * 在没有打印机的会话里（受限沙箱、精简系统、部分远程会话），
 * PDF 导出会让 PowerPoint 进程整个崩掉（RPC 0x800706BA / 0x800706BE），
 * 但同一份文件导出 PNG 却完全正常 —— 因为渲染本身没问题，坏的只是打印那条路。
 *
 * 实测数据（71 页的课件，1600×900）：
 *   导出图片   0.11 秒/页，约 121 KB/页，全量约 8 秒 / 8 MB
 *   导出 PDF   PowerPoint 直接崩
 *
 * 产物写进 outDir，文件名 slide-1.png、slide-2.png……
 *
 * @returns {Promise<{ok:boolean, count?:number, files?:string[], error?:string}>}
 */
export async function exportSlidesToImages(inputPath, ext, outDir) {
  if (!config.enableOfficeConvert) {
    return { ok: false, error: 'Office 转换功能已在配置中关闭' };
  }
  if (!PPT_EXTS.includes(ext)) {
    return { ok: false, error: `只有 PPT 能导出成图片，当前是 ${ext}` };
  }

  const ready = converterReadiness();
  if (!ready.available || ready.converter.type === 'libreoffice') {
    // LibreOffice 那条路我们用 --convert-to pdf，导出图片要另写一套参数，
    // 目前没有实际需求，就不为了对称而硬做
    return { ok: false, error: '当前没有可用的 PowerPoint COM，无法导出幻灯片图片' };
  }

  await fsp.mkdir(outDir, { recursive: true });

  const counter = () => fsp.readdir(outDir)
    .then((names) => names.filter((f) => /^slide-\d+\.png$/.test(f)).length)
    .catch(() => 0);

  // 分块导出。
  //
  // 为什么不一口气导完：实测一份 71 页的课件，PowerPoint 连续导出到第 54 页
  // 就会崩（RPC 断开），剩下的 17 页全丢。分块之后每块用全新的 PowerPoint 实例，
  // 某一块崩了只影响那一块，前面的成果还在，后面的还能继续。
  //
  // 块大小取 20：太小会让 PowerPoint 反复冷启动（每次一两秒），
  // 太大又攒回原来的问题。
  const chunkLogs = [];
  let total = null;
  let exported = 0;

  // 先探一下总页数：导第一块的时候官方会报出来
  for (let from = 1; total === null || from <= total; from += SLIDE_CHUNK_SIZE) {
    const to = from + SLIDE_CHUNK_SIZE - 1;

    // 已经导出来的页不用重来（某块崩了之后外部也可能已经补上）
    const lines = await runSlideChunk(ready.converter.type, inputPath, outDir, from, to);
    chunkLogs.push(...lines);

    const totalLine = lines.find((l) => /^总页数\s*\d+/.test(l));
    if (totalLine) total = Number(totalLine.match(/\d+/)[0]);

    const now = await counter();
    // 这一块一页都没多出来，说明卡住了，别再无意义地重试
    if (now === exported && total !== null && from > 1) {
      chunkLogs.push(`FAIL 第 ${from} 页起导不出来（PowerPoint 可能已经不稳定）`);
      break;
    }
    exported = now;

    if (total !== null && exported >= total) break;

    // 官方没报页数就只试第一块，别无限循环
    if (total === null) break;
  }

  const files = (await fsp.readdir(outDir))
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => path.join(outDir, f));

  if (files.length) {
    return {
      ok: true,
      count: files.length,
      files,
      total,
      // PowerPoint 报了总页数就拿来对一下。少页了不能当完整成功 ——
      // 用户会以为后面几页本来就空。
      partial: total !== null && files.length < total,
      log: chunkLogs.filter((l) => l.startsWith('FAIL')).join('；'),
    };
  }

  // 一张图都没有，这时才看脚本的说明
  const verdict = chunkLogs.find((l) => l.startsWith('OK') || l.startsWith('FAIL')) || '';
  if (verdict.startsWith('FAIL')) {
    return {
      ok: false,
      error: chunkLogs.filter((l) => !l.startsWith('STEP')).join('；').slice(0, 400),
    };
  }
  return { ok: false, error: '导出结束但一张图都没有生成。' };
}

/** 每块导出多少页。PowerPoint 连续导出几十页后容易崩，分块能显著提高完整率。 */
const SLIDE_CHUNK_SIZE = 20;

/** 生成导出幻灯片的 PowerShell 脚本 */
function buildSlideExportScript(converterType, inputPath, outDir, logPath, { from, to }) {
  const In = psQuote(inputPath);
  const Log = psQuote(logPath);
  const progId = converterType === 'wps' ? 'KWPP.Application' : 'PowerPoint.Application';

  // 路径前缀要拼进 PowerShell **双引号**字符串里（因为 $i 需要展开），
  // 所以这里不能用 psQuote —— 那个是给单引号字面量用的，会把引号一起带进去，
  // 结果路径变成 'C:\...\slide'-1.png（带着两个单引号），
  // PowerPoint 报「储存此文件时发生错误」。
  const dirPrefix = path.join(outDir, 'slide')
    .replace(/`/g, '``')
    .replace(/\$/g, '`$');

  return `$ErrorActionPreference = 'Stop'
$logFile = ${Log}
$lines = New-Object System.Collections.ArrayList
function Note($t) { [void]$lines.Add($t) }
try {
  $app = New-Object -ComObject ${progId}
  Note 'STEP app'
  # Visible 是 MsoTriState 枚举，写 $true 会抛类型转换错。msoTrue = -1。
  try { $app.Visible = -1 } catch { Note ("WARN Visible: " + $_.Exception.Message) }

  # 第四个参数 WithWindow 必须是 msoTrue(-1)，否则 PowerPoint 会报
  # "PowerPoint could not open the file"。三个参数都用整数，别用 $true/$false。
  $doc = $app.Presentations.Open(${In}, -1, 0, -1)
  Note 'STEP open'
  Note ("总页数 " + $doc.Slides.Count)

  # 这一块要导的页码范围，越界就夹回来
  $from = [Math]::Max(1, ${from})
  $to = [Math]::Min($doc.Slides.Count, ${to})
  Note ("本块 " + $from + "-" + $to)

  # 双引号里 $i 才会展开。用单引号的话所有页会写进同一个叫 slide-$i.png 的文件。
  for ($i = $from; $i -le $to; $i++) {
    $target = "${dirPrefix}-$i.png"
    $doc.Slides.Item($i).Export($target, 'PNG', 1600, 900)
  }
  Note 'STEP export'
  Note ("本块导出 " + ($to - $from + 1) + " 页")

  $doc.Close()
  $app.Quit()
  Note 'OK'
} catch {
  Note ("FAIL " + $_.Exception.Message)
  try { Note ("HRESULT: 0x" + ('{0:X8}' -f $_.Exception.HResult)) } catch {}
  Note ("最后成功的步骤: " + $(if ($lines -contains 'STEP open') { '文件已打开' }
    elseif ($lines -contains 'STEP app') { 'Office 已启动' } else { '还没启动 Office' }))
}
Set-Content -Path $logFile -Value $lines -Encoding UTF8
`;
}

/** 跑一块导出，返回这一块的日志行 */
async function runSlideChunk(converterType, inputPath, outDir, from, to) {
  const logPath = path.join(config.cacheDir, `slide-${crypto.randomBytes(4).toString('hex')}.log`);
  const consoleLog = `${logPath}.ps`;
  const script = buildSlideExportScript(converterType, inputPath, outDir, logPath, { from, to });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  try {
    await spawnToLog(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        logPath: consoleLog,
        timeoutMs: 300_000,
        timeoutMessage: '导出幻灯片超时（300 秒）。',
      },
    );
    return readLog(logPath).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    return [`FAIL ${err.message}`];
  } finally {
    fsp.rm(logPath, { force: true }).catch(() => {});
    fsp.rm(consoleLog, { force: true }).catch(() => {});
  }
}

/**
 * 转换状态描述，用于设置页展示「你的电脑能不能转 PPT」。
 *
 * 这里必须说真话：以前它只看磁盘上有没有 POWERPNT.EXE，
 * 有就报「可用，预览效果与原件一致」。可实际上 COM 还要靠 PowerShell 起进程，
 * 而受限环境里 PowerShell 根本起不来——于是界面承诺得很好，
 * 用户上传完看到的却是纯文字预览，完全不知道哪儿出了问题。
 */
export function converterStatus() {
  const ready = converterReadiness();

  if (ready.available) {
    if (ready.converter.type === 'libreoffice') {
      return {
        available: true,
        label: ready.converter.label,
        message: `${ready.converter.label} 可用，PPT / Word / Excel 会自动转换成 PDF，预览效果与原件一致。`,
      };
    }
    return {
      available: true,
      label: ready.converter.label,
      message:
        `${ready.converter.label} 可用（PowerShell 正常），`
        + 'PPT / Word / Excel 会自动转换成 PDF，预览效果与原件一致。',
    };
  }

  if (ready.reason === 'powershell-unavailable') {
    return {
      available: false,
      label: `${ready.converter.label}（调不动）`,
      powershellUnavailable: true,
      message:
        `检测到 ${ready.converter.label}，但它需要靠 PowerShell 调用 COM 组件，`
        + `而${ready.powershell.message}`
        + ' 课件内容不会丢，目前用内置解析器渲染成网页版（只保留文字和结构，没有排版）。'
        + '装个免费的 LibreOffice 可以绕开 PowerShell，它也走不通时请把这条信息反馈给开发者。',
    };
  }

  return {
    available: false,
    label: '未检测到',
    message:
      '未找到 LibreOffice / Microsoft Office / WPS。'
      + 'PPT、Word、Excel 将使用内置解析器渲染成网页版预览（排版会简化），不影响查看内容。',
  };
}
