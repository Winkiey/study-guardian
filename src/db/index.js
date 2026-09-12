/**
 * 数据库访问层。
 *
 * 直接用 Node.js 内置的 node:sqlite（Node 22.5+ 提供），
 * 因此不需要 better-sqlite3 这类原生模块，也就不需要编译工具链。
 * 这是「克隆下来就能跑」的关键之一。
 */

import { DatabaseSync } from 'node:sqlite';
import config, { ensureRuntimeDirs } from '../config.js';
import { SCHEMA_SQL, SCHEMA_VERSION, MIGRATIONS } from './schema.js';

let db = null;

/** 把 node:sqlite 返回的行统一成普通对象（避免 null 原型带来的意外） */
function toPlain(row) {
  return row == null ? row : { ...row };
}

function toPlainAll(rows) {
  return rows.map(toPlain);
}

/**
 * 打开数据库并执行迁移。重复调用返回同一个连接。
 */
export function getDb() {
  if (db) return db;

  ensureRuntimeDirs();
  db = new DatabaseSync(config.dbFile);

  // WAL 让读写并发更顺畅；课表页面查询频繁时体验更好
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  migrate(db);
  return db;
}

/**
 * 基于 PRAGMA user_version 的简单迁移。
 *
 * 两步：
 *   1. 跑 SCHEMA_SQL（全是 CREATE ... IF NOT EXISTS，空库会建全，老库不动）
 *   2. 逐个版本跑 MIGRATIONS —— 给老表补新列这类改动只能走 ALTER TABLE
 *
 * 迁移函数都写成幂等的，所以中途失败重跑也不会出问题。
 */
function migrate(database) {
  const row = database.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);

  if (current >= SCHEMA_VERSION) return;

  database.exec('BEGIN');
  try {
    database.exec(SCHEMA_SQL);

    for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
      for (const step of MIGRATIONS[version] || []) {
        step(database);
      }
    }

    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

// ------------------------------------------------------------
// 查询快捷方法
// ------------------------------------------------------------

/** 取多行 */
export function all(sql, ...params) {
  return toPlainAll(getDb().prepare(sql).all(...params));
}

/** 取一行，没有则返回 undefined */
export function get(sql, ...params) {
  return toPlain(getDb().prepare(sql).get(...params));
}

/** 执行写入，返回 { changes, lastInsertRowid } */
export function run(sql, ...params) {
  const result = getDb().prepare(sql).run(...params);
  return {
    changes: Number(result.changes ?? 0),
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
  };
}

/** 取单个标量值（第一列） */
export function scalar(sql, ...params) {
  const row = get(sql, ...params);
  if (!row) return undefined;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : undefined;
}

/**
 * 事务包装。回调里抛错会自动回滚。
 * 注意：node:sqlite 是同步 API，所以回调必须是同步函数。
 */
export function tx(fn) {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

/** 关闭连接（测试与优雅退出用） */
export function closeDb() {
  if (db) {
    try {
      db.close();
    } catch {
      /* 忽略重复关闭 */
    }
    db = null;
  }
}
