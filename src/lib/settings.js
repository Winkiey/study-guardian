/**
 * 个人设置的键值存取。
 *
 * 用法：`getSetting(userId, 'daily_digest_time', '07:30')`，
 * 只给字符串，复杂结构自己 JSON 化。
 */

import { all, run } from '../db/index.js';
import {
  DEFAULT_PERIOD_SCHEDULE,
  normalizePeriodSchedule,
} from './periods.js';

/** 读取一项设置 */
export function getSetting(userId, key, fallback = '') {
  const rows = all(
    'SELECT value FROM settings WHERE user_id = ? AND key = ?',
    userId,
    key,
  );
  const value = rows[0]?.value;
  return value === undefined || value === null ? fallback : value;
}

/** 写入一项设置 */
export function setSetting(userId, key, value) {
  run(
    `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    userId,
    key,
    String(value ?? ''),
  );
}

/** 批量读取成对象 */
export function getSettings(userId, defaults = {}) {
  const rows = all('SELECT key, value FROM settings WHERE user_id = ?', userId);
  const out = { ...defaults };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/** 批量写入 */
export function setSettings(userId, patch) {
  for (const [key, value] of Object.entries(patch)) {
    setSetting(userId, key, value);
  }
}

/** 布尔读取 */
export function getBoolSetting(userId, key, fallback = false) {
  const v = getSetting(userId, key, fallback ? '1' : '0');
  return v === '1' || v === 'true';
}

// ============================================================
// 设置的默认值与元信息
// ============================================================

/**
 * 全部设置项的默认值。
 * 前端设置页会用它来渲染表单，所以字段带着说明文字。
 */
export const SETTING_DEFS = [
  {
    key: 'display_name',
    label: '称呼',
    type: 'text',
    default: '',
    help: '首页问候语会用这个名字。',
  },
  {
    key: 'school',
    label: '学校',
    type: 'text',
    default: '东北财经大学',
    help: '仅用于展示。',
  },
  {
    key: 'default_remind_offsets',
    label: '新建作业的默认提醒',
    type: 'text',
    default: '1440,120',
    help: '单位是分钟。1440 = 提前 1 天，120 = 提前 2 小时。多个用英文逗号分隔。',
  },
  {
    key: 'daily_digest_enabled',
    label: '每日简报',
    type: 'switch',
    default: '0',
    help: '每天早上把「今天的课 + 快到的作业」推送到手机。',
  },
  {
    key: 'daily_digest_time',
    label: '简报发送时间',
    type: 'time',
    default: '07:30',
    help: '按这个时间发。需要先在上面配好至少一个提醒渠道。',
  },
  {
    key: 'daily_digest_channels',
    label: '简报使用的渠道',
    type: 'text',
    default: '',
    help: '留空 = 使用所有已启用渠道。也可以填渠道类型，如 bark,email。',
  },
  {
    key: 'week_start_monday',
    label: '每周从周一开始',
    type: 'switch',
    default: '1',
    help: '国内课表习惯从周一开始。',
  },
  {
    key: 'period_schedule',
    // 这一项是结构化的，由设置页的专用编辑器渲染，不走通用文本输入框
    type: 'periods',
    label: '作息时间表',
    default: '',
    help: '每个「节次」对应的具体时间。导入课表时遇到「第 3-4 节」这种写法会按它换算，'
      + '课程表页的上课时间也会按它对齐。和你们学校不一致时，在这里改一次就好。',
  },
];

/** 组装默认值对象 */
export function settingDefaults() {
  const out = {};
  for (const def of SETTING_DEFS) out[def.key] = def.default;
  return out;
}

// ============================================================
// 作息时间表（纯计算部分在 lib/periods.js，这里只管存取）
// ============================================================

export {
  DEFAULT_PERIOD_SCHEDULE,
  normalizePeriodSchedule,
  periodsToClock,
  periodLabel,
  rangeLabel,
  findPeriodByTime,
  resolvePeriodSpan,
  describeSchedule,
  scheduleBounds,
} from './periods.js';

/** 读取用户的作息时间表；没设置过就返回默认值 */
export function getPeriodSchedule(userId) {
  const raw = getSetting(userId, 'period_schedule', '');
  if (!raw) return DEFAULT_PERIOD_SCHEDULE;

  try {
    const parsed = normalizePeriodSchedule(JSON.parse(raw));
    return parsed || DEFAULT_PERIOD_SCHEDULE;
  } catch {
    return DEFAULT_PERIOD_SCHEDULE;
  }
}

/**
 * 保存作息时间表。
 *
 * 如果传进来的内容跟内置默认值完全一样，就当成「恢复默认」处理，
 * 直接把设置项清空——否则界面会一直显示「已自定义」，误导用户。
 *
 * @throws {Error} 数据全不合法时抛错（部分不合法会被静默丢弃）
 */
export function savePeriodSchedule(userId, schedule) {
  const normalized = normalizePeriodSchedule(schedule);
  if (!normalized) {
    throw new Error(
      '作息时间表格式不正确。每一节需要填「第几节」和它的开始、结束时间，'
      + '时间写成 08:00 这样的格式，且结束时间要晚于开始时间。',
    );
  }

  if (isSameSchedule(normalized, DEFAULT_PERIOD_SCHEDULE)) {
    clearPeriodSchedule(userId);
    return DEFAULT_PERIOD_SCHEDULE;
  }

  setSetting(userId, 'period_schedule', JSON.stringify(normalized));
  return normalized;
}

/** 清空自定义作息表，回到内置默认值 */
export function clearPeriodSchedule(userId) {
  setSetting(userId, 'period_schedule', '');
}

/** 用户是否自定义过作息表（用于界面提示「当前用的是默认值」） */
export function hasCustomPeriodSchedule(userId) {
  const raw = getSetting(userId, 'period_schedule', '');
  if (!raw) return false;

  try {
    const parsed = normalizePeriodSchedule(JSON.parse(raw));
    if (!parsed) return false;
    // 存的内容恰好等于默认值时，也不该算「自定义过」
    return !isSameSchedule(parsed, DEFAULT_PERIOD_SCHEDULE);
  } catch {
    return false;
  }
}

/** 两份作息表在语义上是否相同（节次与时间都一致） */
function isSameSchedule(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((row, i) => (
    row.index === b[i].index
    && row.start === b[i].start
    && row.end === b[i].end
  ));
}
