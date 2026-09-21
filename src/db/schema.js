/**
 * 数据库结构定义。
 *
 * 所有时间字段统一使用**本地时间的字符串**存储，格式：
 *   'YYYY-MM-DD HH:MM'      精确到分钟（作业 DDL）
 *   'YYYY-MM-DD HH:MM:SS'   精确到秒（提醒触发时刻）
 *   'YYYY-MM-DD'            只到天（课表日期、学期起始）
 *
 * 这样做的原因：这是一个面向个人的课表/作业工具，
 * 用户脑子里的「周三 8 点」就是本地时间。用 UTC 存储反而到处要换算、容易错。
 * 代价是换时区后旧数据不会自动平移——个人自用场景下这不是问题。
 */

/** 当前结构版本号，配合 PRAGMA user_version 做迁移 */
export const SCHEMA_VERSION = 9;

/**
 * 课程标记色的默认值。
 *
 * 前端主色换成 #3a63e8 之后，这个旧默认值 #4f7cff 就成了「另一种蓝」，
 * 课表色块、课程卡顶条、各种小圆点全是它，跟界面上其它蓝色互相打架。
 * 改默认值只影响以后新建的课，已经建好的那批要靠 v3 迁移一起洗掉。
 *
 * 前端 app.js 里有一份同样的字面量（浏览器端拿不到这个模块），
 * 改的时候两边要一起改。
 */
export const DEFAULT_COURSE_COLOR = '#3a63e8';
const LEGACY_COURSE_COLOR = '#4f7cff';

/**
 * 版本之间的增量迁移。
 *
 * 为什么需要它：SCHEMA_SQL 里全是 `CREATE TABLE IF NOT EXISTS`，
 * 对**已经存在**的表不会补上新列。所以给老表加字段必须写 ALTER TABLE。
 *
 * 写成函数而不是 SQL 语句，是为了能做成幂等的：
 * 全新数据库会先按 SCHEMA_SQL 建表（已经包含新列），
 * 如果这里再 ALTER 一次就会报「duplicate column name」。
 */
export const MIGRATIONS = {
  // v2：课件支持「导出幻灯片为图片」这条渲染路径
  2: [
    (db) => addColumnIfMissing(db, 'materials', 'slides_dir', "TEXT NOT NULL DEFAULT ''"),
  ],
  // v3：把还停在旧默认色上的课程换成新主色。
  // 只认精确等于旧默认值的那一批 —— 用户自己挑过的颜色一律不动。
  // 本身的 WHERE 就保证了幂等，重跑第二次影响 0 行。
  3: [
    (db) => db.prepare('UPDATE courses SET color = ? WHERE color = ?')
      .run(DEFAULT_COURSE_COLOR, LEGACY_COURSE_COLOR),
  ],
  // v4：多用户。
  // 用户名原来只在「逐字节完全相等」上唯一（SQLite 的 TEXT 默认区分大小写），
  // 于是 Alice 和 alice 可以同时注册成两个账号：后注册的人以为自己拿到了
  // 那个名字，实际上登录时也得原样拼对大小写，输错一个字母就进不去，
  // 而按名字发邀请码、认人时更是必然搞混。
  // 用表达式索引把口径统一成「小写后唯一」，改动最小又能让数据库自己兜住。
  4: [
    (db) => db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower '
      + 'ON users(lower(username))',
    ),
  ],
  // v5：让「已经发出去的钥匙」能作废。
  //
  // 会话 Cookie 和日历订阅链接都是**无状态签名令牌**：服务端不存它们，
  // 只看签名对不对。好处是不用查表、重启不掉线；坏处是**发出去就收不回来**。
  // 日历链接尤其难受 —— 有效期一年、不需要登录，谁拿到链接谁就能看你的课表，
  // 而唯一的作废办法是换 SESSION_SECRET，那会把所有人的登录状态一起清掉。
  //
  // 加两个计数器就解决了：令牌里带上当时的计数值，校验时跟库里的比。
  // 想作废就把计数 +1，旧令牌立刻全部失效，而且只影响这一个人。
  //
  //   改密码          → 两个都 +1（钥匙可能就是因为密码泄露才丢的）
  //   退出其他设备    → session_version + 1
  //   重新生成订阅链接 → calendar_version + 1
  //
  // 默认 0，而且**旧格式的令牌（不带计数值）按 0 处理** ——
  // 这样升级本身不会把任何人踢下线、也不会让已经订阅好的日历失效；
  // 一旦哪次真的 +1 了，那些旧令牌照样一起失效。兼容和有效两头都不丢。
  5: [
    (db) => addColumnIfMissing(db, 'users', 'session_version', 'INTEGER NOT NULL DEFAULT 0'),
    (db) => addColumnIfMissing(db, 'users', 'calendar_version', 'INTEGER NOT NULL DEFAULT 0'),
  ],
  // v6：校友社区要用的资料字段。
  //
  // school 加这两个字段只是开始 —— 真正的改动是「学校从固定名单里选」。
  // 为什么要名单：社区里「同校」是**唯一**的可见性边界，
  // 而手填的学校挡不住「家里蹲大学」；有名单才能靠精确相等判断同校，
  // 不用做模糊匹配（「北大」和「北京大学」算不算同校？模糊匹配永远答不清，
  // 而答不清就意味着有人能看到本不该看到的资料）。
  //
  // ⚠️ 老账号的 school 是手填的，**不迁移、不清空**：用户自己填过的值不能
  //    被代码删掉。页面上会把它标成「未从名单选择」并提示重选一次；
  //    在重选之前，这个人不参与社区（因为同校判断匹配不上）。
  6: [
    (db) => addColumnIfMissing(db, 'users', 'college', "TEXT NOT NULL DEFAULT ''"),
    (db) => addColumnIfMissing(db, 'users', 'major', "TEXT NOT NULL DEFAULT ''"),
  ],
  // v7：头像。
  //
  // 只加一列存**扩展名**（'png' / 'jpg'），不存路径也不存二进制：
  //   · 路径由 userId 拼（data/avatars/<id>.<ext>），不含用户提供的字符串，
  //     所以不存在路径穿越的余地；
  //   · 图片本身放磁盘，数据库不因为几张头像膨胀。
  // 空串 = 没有头像，前端就显示昵称首字母。默认空串，所以升级后谁都不受影响。
  7: [
    (db) => addColumnIfMissing(db, 'users', 'avatar_ext', "TEXT NOT NULL DEFAULT ''"),
  ],
  // v8：资料可以「公开给同校」。
  //
  // ⚠️ 默认 0（不公开），而且是**每份资料单独设**。这是用户拍板的：
  //    有些课件不适合公开（老师的东西、带答案的、自己整理的笔记），
  //    所以不能给一个"整个资料库一刀切"的开关 —— 那样要么全公开、
  //    要么全不公开，两种都有人不满意。
  //
  // 加了这一列之后，文件服务的授权从「只有本人」变成
  // 「本人 或（已公开 且 同校）」—— 见 src/routes/files.js 的 resolveMaterial。
  // 那是这一批里风险最高的一处：改错了就是别人能看到你的文件。
  8: [
    (db) => addColumnIfMissing(db, 'materials', 'published', 'INTEGER NOT NULL DEFAULT 0'),
  ],
  // v9：用户名改成**彻底区分大小写**，把 v4 那个 lower() 索引撤掉。
  //
  // v4 的推理是「登录不区分大小写，所以库里不能同时有 Alice 和 alice，
  // 否则不知道该登进哪一个」。现在登录改成精确匹配了，那个前提不成立 ——
  // 精确匹配下「Alice 和 alice 同时存在」不会产生任何歧义，两个名字
  // 就是两个账号。留着那个索引反而矛盾：它禁止注册一个**能正常登录**的名字。
  //
  // 撤掉之后唯一性靠 users.username 上的 `TEXT NOT NULL UNIQUE` ——
  // SQLite 的 TEXT 默认是 BINARY 比较，本身就不折叠大小写，正好是想要的
  // 口径，所以这里**只删不加**，不需要再建一个新索引。
  // （那个 UNIQUE 自带一个隐式索引，`WHERE username = ?` 照样走索引。）
  //
  // 已有数据一定安全：老索引保证了库里不可能出现只差大小写的两行，
  // 所以删索引这一步不会撞上重复键。
  9: [
    (db) => db.exec('DROP INDEX IF EXISTS idx_users_username_lower'),
  ],
};

/** 缺了才加，已经有了就跳过（让迁移可以安全重跑） */
export function addColumnIfMissing(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

export const SCHEMA_SQL = `
-- ============================================================
-- 用户。多用户：每个人的数据靠各表的 user_id 隔开。
--
-- username 上的唯一性只有一条：这个 UNIQUE 约束。
-- SQLite 的 TEXT 默认按 BINARY 比较，所以它是**区分大小写**的：
-- Alice 和 alice 是两个不同的账号，可以同时存在（v9 起就是这个口径；
-- v4 曾经用 idx_users_username_lower 禁止过，v9 又把那个索引删了）。
--
-- ⚠️ 加 COLLATE NOCASE 或者改回 lower() 索引之前，先去看 v4 / v9 两段注释：
--    唯一性口径必须和 auth.js 的 findUserByUsername 一致，不一致就会出现
--    「注册时说这名字被占了、登录时又登不进任何账号」这种死结。
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL DEFAULT '',
  password_hash    TEXT NOT NULL,
  school           TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  -- 两个「吊销计数器」。见 v5 迁移里的说明：会话令牌和日历订阅令牌
  -- 都是无状态签名令牌，想把已经发出去的作废，唯一办法就是把计数 +1。
  session_version  INTEGER NOT NULL DEFAULT 0,
  calendar_version INTEGER NOT NULL DEFAULT 0,
  -- 校友社区用的资料。school 以后从固定名单里选（见 src/data/schools.js），
  -- 因为「同校」是社区**唯一**的可见性边界，名字对不上边界就等于没有。
  college          TEXT NOT NULL DEFAULT '',
  major            TEXT NOT NULL DEFAULT '',
  -- 头像的扩展名（'png' / 'jpg'）或空串。**只存扩展名，不存路径**：
  -- 路径由 userId 拼出来（见 src/lib/avatar.js），路径里不含任何用户提供的
  -- 字符串，于是不存在路径穿越的余地，也不用再写一层过滤。
  avatar_ext       TEXT NOT NULL DEFAULT ''
);
-- 用户名上**没有**额外的索引了：唯一致约束就是上面那个 UNIQUE
-- （v9 删掉了 v4 加的 idx_users_username_lower，见那两段注释）。

-- ============================================================
-- 学期。课表的周次计算依赖「第 1 周周一」是哪一天。
-- ============================================================
CREATE TABLE IF NOT EXISTS terms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  start_date TEXT NOT NULL,
  week_count INTEGER NOT NULL DEFAULT 18,
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_terms_user ON terms(user_id, is_active DESC);

-- ============================================================
-- 课程
-- ============================================================
CREATE TABLE IF NOT EXISTS courses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_id         INTEGER REFERENCES terms(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL DEFAULT '',
  teacher         TEXT NOT NULL DEFAULT '',
  teacher_contact TEXT NOT NULL DEFAULT '',
  credits         REAL,
  hours           INTEGER,
  category        TEXT NOT NULL DEFAULT '',
  exam_type       TEXT NOT NULL DEFAULT '',
  classroom       TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '#3a63e8',
  notes           TEXT NOT NULL DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id, archived, sort_order);

-- ============================================================
-- 每周重复的上课时间。
-- weeks 是周次表达式，支持：
--   '1-16'        第 1 到 16 周
--   '1-16单'      第 1 到 16 周的奇数周
--   '1-16双'      偶数周
--   '1-8,10-16'   多段
--   '3'           只有第 3 周
-- ============================================================
CREATE TABLE IF NOT EXISTS course_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  weeks      TEXT NOT NULL DEFAULT '1-16',
  location   TEXT NOT NULL DEFAULT '',
  teacher    TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_course ON course_sessions(course_id);

-- ============================================================
-- 单次调课 / 停课。教务处的课表经常有「本周三的课调到周五」。
-- ============================================================
CREATE TABLE IF NOT EXISTS course_exceptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id      INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,
  action         TEXT NOT NULL DEFAULT 'cancel',
  new_date       TEXT NOT NULL DEFAULT '',
  new_start_time TEXT NOT NULL DEFAULT '',
  new_end_time   TEXT NOT NULL DEFAULT '',
  new_location   TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_exceptions_course ON course_exceptions(course_id, date);

-- ============================================================
-- 成绩构成：平时 30% + 期中 20% + 期末 50% 这类结构
-- ============================================================
CREATE TABLE IF NOT EXISTS grade_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 0,
  score      REAL,
  full_score REAL NOT NULL DEFAULT 100,
  note       TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_grade_items_course ON grade_items(course_id, sort_order);

-- ============================================================
-- 课件资料
-- ============================================================
CREATE TABLE IF NOT EXISTS materials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id      INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT 'courseware',
  source         TEXT NOT NULL DEFAULT '',
  week           INTEGER,
  tags           TEXT NOT NULL DEFAULT '',

  original_name  TEXT NOT NULL,
  stored_name    TEXT NOT NULL,
  ext            TEXT NOT NULL DEFAULT '',
  mime           TEXT NOT NULL DEFAULT '',
  size           INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL DEFAULT 'other',

  pdf_name       TEXT NOT NULL DEFAULT '',
  -- 「把每一页导出成图片」这条渲染路径的产物目录（相对 uploads 目录）。
  -- 有些环境下 Office 导不出 PDF（例如会话里没有打印机），但导出图片是可以的。
  slides_dir     TEXT NOT NULL DEFAULT '',
  slide_count    INTEGER,
  text_cache     TEXT NOT NULL DEFAULT '',
  preview_status TEXT NOT NULL DEFAULT 'pending',
  preview_error  TEXT NOT NULL DEFAULT '',

  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_materials_user ON materials(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id, created_at DESC);

-- ============================================================
-- 作业
-- ============================================================
CREATE TABLE IF NOT EXISTS assignments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id       INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  due_at          TEXT,
  status          TEXT NOT NULL DEFAULT 'todo',
  priority        INTEGER NOT NULL DEFAULT 1,
  progress        INTEGER NOT NULL DEFAULT 0,
  submitted_at    TEXT,
  score           REAL,
  full_score      REAL DEFAULT 100,
  weight          REAL,
  material_id     INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  remind_offsets  TEXT NOT NULL DEFAULT '1440,120',
  notify_channels TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_assignments_user ON assignments(user_id, status, due_at);

-- ============================================================
-- 待发提醒。由作业自动派生，也可以手动建自定义提醒。
-- ============================================================
CREATE TABLE IF NOT EXISTS reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'assignment',
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  fire_at       TEXT NOT NULL,
  channels      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',
  sent_at       TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, fire_at);
CREATE INDEX IF NOT EXISTS idx_reminders_assignment ON reminders(assignment_id);

-- ============================================================
-- 通知渠道配置（Bark / 邮件 / 企业微信 / ntfy / Webhook ...）
-- config 存 JSON，字段随 type 变化。
-- ============================================================
CREATE TABLE IF NOT EXISTS notify_channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  config     TEXT NOT NULL DEFAULT '{}',
  enabled    INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_channels_user ON notify_channels(user_id);

-- ============================================================
-- 发送日志，方便排查「为什么没收到提醒」
-- ============================================================
CREATE TABLE IF NOT EXISTS notify_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  reminder_id  INTEGER,
  channel_type TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  ok           INTEGER NOT NULL DEFAULT 0,
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notify_log_user ON notify_log(user_id, created_at DESC);

-- ============================================================
-- 个人设置（键值对）
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, key)
);
`;
