/**
 * 配置加载。
 *
 * 优先级：真实环境变量 > .env 文件 > 内置默认值。
 * 同时负责创建运行期目录、生成会话密钥。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

/** 项目根目录（src/ 的上一级） */
export const ROOT = path.resolve(path.dirname(__filename), '..');

/**
 * 极简 .env 解析器。
 * 支持 `KEY=VALUE`、`#` 注释、`export KEY=VALUE`、
 * 值可用单/双引号包裹（双引号内支持 \n \t 转义）。
 */
function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (!key) continue;

    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
        if (quote === '"') {
          value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
        }
      }
    }
    out[key] = value;
  }
  return out;
}

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  try {
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const dotenv = loadDotEnv();

/** 读取配置项：环境变量优先，其次 .env，最后默认值 */
function env(key, fallback = '') {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const fromFile = dotenv[key];
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  return fallback;
}

function envBool(key, fallback) {
  const v = String(env(key, fallback ? 'true' : 'false')).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envInt(key, fallback) {
  const n = Number.parseInt(env(key, String(fallback)), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 决定生效的时区。
 *
 * 只在**显式**配了 TZ 时才返回 explicit=true —— 没配就用操作系统的时区，
 * 不强行给别的时区的人塞北京时间。
 *
 * 抽成纯函数是为了能直接测：真实场景里要验「.env 给了 TZ、但进程环境没给」
 * 这一格，而这一格没法在测试里靠改真实 .env 来复现。
 */
export function resolveTimezone(processEnvValue, dotenvValue, fallback = 'Asia/Shanghai') {
  const hasProcess = processEnvValue !== undefined && processEnvValue !== '';
  const hasFile = dotenvValue !== undefined && dotenvValue !== '';
  return {
    value: hasProcess ? processEnvValue : hasFile ? dotenvValue : fallback,
    explicit: hasProcess || hasFile,
  };
}

const TIMEZONE = resolveTimezone(process.env.TZ, dotenv.TZ);

/**
 * 把时区真正写回进程环境。
 *
 * 这一步不能省：课表、作业 DDL、提醒时间全部按「本地时间的字符串」存取，
 * 而 `datetime.js` 取「现在」用的是 `new Date()` —— 那是**进程的本地时区**。
 * 只把 TZ 读进配置对象是没用的，`.env` 里写了也不会生效。
 *
 * 真实后果（不是理论）：云服务器默认时区多为 UTC，`.env` 里明明写着
 * `TZ=Asia/Shanghai` 却不生效，于是「应用认为的现在」比北京时间慢 8 小时，
 * 所有提醒迟发 8 小时。而且不报任何错，只有到点了收不到推送才会发现。
 * 本机开发时看不出来 —— 因为自己的电脑本来就是对的时区。
 */
if (TIMEZONE.explicit) process.env.TZ = TIMEZONE.value;

/**
 * 数据目录。默认是项目下的 data/，可以用环境变量 DATA_DIR 覆盖。
 * 覆盖能力用于：跑端到端测试时用临时目录、一台机器跑多个实例、Docker 挂载卷。
 */
const DATA_DIR = env('DATA_DIR', '')
  ? path.resolve(env('DATA_DIR'))
  : path.join(ROOT, 'data');

/** 确保目录存在 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 获取会话密钥。首次运行时随机生成 32 字节并写入 data/secret.key。
 * 该文件权限设为仅本人可读（Windows 上忽略权限位，靠 .gitignore 保护）。
 */
function loadSessionSecret() {
  const configured = env('SESSION_SECRET', '');
  if (configured) return configured;

  ensureDir(DATA_DIR);
  const keyFile = path.join(DATA_DIR, 'secret.key');
  try {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 文件不存在，继续生成 */
  }

  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  uploadDir: path.join(DATA_DIR, 'uploads'),
  cacheDir: path.join(DATA_DIR, 'cache'),
  dbFile: path.join(DATA_DIR, 'app.db'),

  port: envInt('PORT', 3081),
  host: env('HOST', '127.0.0.1'),
  appName: env('APP_NAME', '学习守护'),
  timezone: TIMEZONE.value,

  soforcePath: env('SOFFICE_PATH', ''),
  maxUploadBytes: envInt('MAX_UPLOAD_MB', 200) * 1024 * 1024,
  enableOfficeConvert: envBool('ENABLE_OFFICE_CONVERT', true),

  schedulerIntervalSec: Math.max(10, envInt('SCHEDULER_INTERVAL_SEC', 60)),
  schedulerRunOnStart: envBool('SCHEDULER_RUN_ON_START', true),

  /** 生产模式标记，用于关闭调试信息 */
  isDev: env('NODE_ENV', 'development') !== 'production',
};

/** 创建运行期所需目录 */
export function ensureRuntimeDirs() {
  ensureDir(config.dataDir);
  ensureDir(config.uploadDir);
  ensureDir(config.cacheDir);
  ensureDir(path.join(config.cacheDir, 'pdf'));
  ensureDir(path.join(config.cacheDir, 'thumb'));
}

// 会话密钥在模块加载时确定（会顺带创建 data 目录）
config.sessionSecret = loadSessionSecret();

export default config;
