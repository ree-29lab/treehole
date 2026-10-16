/**
 * SQLite storage. One process, one connection, WAL mode.
 * Every statement is prepared with bound parameters; no query is built by string
 * concatenation, and raw device ids / IPs are never stored (see src/auth.js).
 */

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  mood TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  folded INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  hug_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  code TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  folded INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  hug_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS hugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  device_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (target_type, target_id, device_hash)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  device_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (target_type, target_id, device_hash)
);
CREATE INDEX IF NOT EXISTS idx_reports_open ON reports(dismissed, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_events(ip_hash, action, created_at);

CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const TABLES = { post: 'posts', comment: 'comments' };

export function tableFor(targetType) {
  const table = TABLES[targetType];
  if (!table) throw new Error(`unknown target type: ${targetType}`);
  return table;
}

export function createPost(db, { body, mood, code, deviceHash, crisis, now }) {
  const info = db
    .prepare(
      `INSERT INTO posts (body, mood, code, device_hash, created_at, folded)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(body, mood, code, deviceHash, now, crisis ? 1 : 0);
  return Number(info.lastInsertRowid);
}

export function setPostCode(db, id, code) {
  db.prepare('UPDATE posts SET code = ? WHERE id = ?').run(code, id);
}

export function createComment(db, { postId, parentId, body, code, deviceHash, crisis, now }) {
  const info = db
    .prepare(
      `INSERT INTO comments (post_id, parent_id, body, code, device_hash, created_at, folded)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(postId, parentId, body, code, deviceHash, now, crisis ? 1 : 0);
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?').run(postId);
  if (parentId) {
    db.prepare('UPDATE comments SET reply_count = reply_count + 1 WHERE id = ?').run(parentId);
  }
  return id;
}

export function getPost(db, id) {
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) ?? null;
}

/**
 * Visible posts, newest first, optionally filtered by mood or restricted to one device.
 * `includeHidden` keeps report-folded posts in the author's own list, so writing
 * something does not silently vanish from the person who wrote it.
 */
export function listPosts(db, { before, limit, mood, deviceHash, includeHidden = false }) {
  const where = ['deleted_at IS NULL'];
  if (!includeHidden) where.push('hidden = 0');
  const params = [];
  if (before) {
    where.push('id < ?');
    params.push(before);
  }
  if (mood) {
    where.push('mood = ?');
    params.push(mood);
  }
  if (deviceHash) {
    where.push('device_hash = ?');
    params.push(deviceHash);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`
    )
    .all(...params);
}

export function listComments(db, postId) {
  return db
    .prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY id ASC')
    .all(postId);
}

export function listRecentComments(db, postId, limit) {
  return db
    .prepare('SELECT * FROM comments WHERE post_id = ? AND hidden = 0 ORDER BY id DESC LIMIT ?')
    .all(postId, limit)
    .reverse();
}

export function commentsIn(db, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM comments WHERE id IN (${placeholders})`).all(...ids);
}

/** @returns {{count: number, added: boolean}} */
export function addHug(db, { targetType, targetId, deviceHash, now }) {
  const table = tableFor(targetType);
  const info = db
    .prepare(
      'INSERT OR IGNORE INTO hugs (target_type, target_id, device_hash, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(targetType, targetId, deviceHash, now);
  if (info.changes > 0) {
    db.prepare(`UPDATE ${table} SET hug_count = hug_count + 1 WHERE id = ?`).run(targetId);
  }
  const row = db.prepare(`SELECT hug_count FROM ${table} WHERE id = ?`).get(targetId);
  return { count: row ? Number(row.hug_count) : 0, added: info.changes > 0 };
}

export function huggedBy(db, { targetType, targetId, deviceHash }) {
  const row = db
    .prepare('SELECT 1 AS hit FROM hugs WHERE target_type = ? AND target_id = ? AND device_hash = ?')
    .get(targetType, targetId, deviceHash);
  return Boolean(row);
}

export function huggedSet(db, { targetType, ids, deviceHash }) {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT target_id FROM hugs WHERE target_type = ? AND device_hash = ? AND target_id IN (${placeholders})`
    )
    .all(targetType, deviceHash, ...ids);
  return new Set(rows.map((row) => Number(row.target_id)));
}

/** @returns {{count: number, hidden: boolean, added: boolean}} */
export function addReport(db, { targetType, targetId, reason, deviceHash, now, threshold }) {
  const table = tableFor(targetType);
  const info = db
    .prepare(
      'INSERT OR IGNORE INTO reports (target_type, target_id, reason, device_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(targetType, targetId, reason, deviceHash, now);
  if (info.changes === 0) {
    const row = db.prepare(`SELECT report_count FROM ${table} WHERE id = ?`).get(targetId);
    return { count: row ? Number(row.report_count) : 0, hidden: false, added: false };
  }
  db.prepare(`UPDATE ${table} SET report_count = report_count + 1 WHERE id = ?`).run(targetId);
  const row = db.prepare(`SELECT report_count FROM ${table} WHERE id = ?`).get(targetId);
  const count = row ? Number(row.report_count) : 0;
  let hidden = false;
  if (count >= threshold) {
    db.prepare(`UPDATE ${table} SET hidden = 1 WHERE id = ?`).run(targetId);
    hidden = true;
  }
  return { count, hidden, added: true };
}

/** Author deletion: the row and its text are really removed. */
export function deleteOwn(db, { targetType, targetId, deviceHash }) {
  const table = tableFor(targetType);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(targetId);
  if (!row || row.device_hash !== deviceHash) return false;
  if (targetType === 'post') {
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(targetId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(targetId);
  } else {
    db.prepare('DELETE FROM comments WHERE parent_id = ?').run(targetId);
    db.prepare('DELETE FROM comments WHERE id = ?').run(targetId);
    db.prepare('UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?').run(row.post_id);
    if (row.parent_id) {
      db.prepare('UPDATE comments SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?').run(row.parent_id);
    }
  }
  db.prepare('DELETE FROM hugs WHERE target_type = ? AND target_id = ?').run(targetType, targetId);
  db.prepare('DELETE FROM reports WHERE target_type = ? AND target_id = ?').run(targetType, targetId);
  return true;
}

/** Admin deletion, kept separate from author deletion so the log stays meaningful. */
export function adminDelete(db, { targetType, targetId, now }) {
  tableFor(targetType);
  if (targetType === 'post') {
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(targetId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(targetId);
  } else {
    db.prepare('DELETE FROM comments WHERE id = ?').run(targetId);
  }
  db.prepare('DELETE FROM hugs WHERE target_type = ? AND target_id = ?').run(targetType, targetId);
  db.prepare('DELETE FROM reports WHERE target_type = ? AND target_id = ?').run(targetType, targetId);
  db.prepare('INSERT INTO admin_log (action, target_type, target_id, created_at) VALUES (?, ?, ?, ?)')
    .run('delete', targetType, targetId, now);
}

export function setHidden(db, { targetType, targetId, hidden, now }) {
  const table = tableFor(targetType);
  db.prepare(`UPDATE ${table} SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, targetId);
  if (hidden) {
    db.prepare('UPDATE reports SET dismissed = 1 WHERE target_type = ? AND target_id = ?')
      .run(targetType, targetId);
  }
  db.prepare('INSERT INTO admin_log (action, target_type, target_id, created_at) VALUES (?, ?, ?, ?)')
    .run(hidden ? 'hide' : 'restore', targetType, targetId, now);
}

export function openReports(db, limit = 50) {
  return db
    .prepare('SELECT * FROM reports WHERE dismissed = 0 ORDER BY created_at DESC LIMIT ?')
    .all(limit);
}

export function hiddenItems(db, limit = 50) {
  const posts = db
    .prepare('SELECT * FROM posts WHERE hidden = 1 ORDER BY id DESC LIMIT ?')
    .all(limit);
  const comments = db
    .prepare('SELECT * FROM comments WHERE hidden = 1 ORDER BY id DESC LIMIT ?')
    .all(limit);
  return { posts, comments };
}

export function dismissReportsFor(db, { targetType, targetId }) {
  db.prepare('UPDATE reports SET dismissed = 1 WHERE target_type = ? AND target_id = ?')
    .run(targetType, targetId);
}

export function exportAll(db) {
  return {
    exportedAt: new Date().toISOString(),
    posts: db.prepare('SELECT id, body, mood, code, created_at, hidden, reply_count, hug_count FROM posts ORDER BY id').all(),
    comments: db
      .prepare('SELECT id, post_id, parent_id, body, code, created_at, hidden, hug_count FROM comments ORDER BY id')
      .all(),
    reports: db.prepare('SELECT id, target_type, target_id, reason, created_at, dismissed FROM reports ORDER BY id').all()
  };
}

export function countPostsSince(db, since) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at >= ?').get(since);
  return Number(row.n);
}

export function countPostsByDeviceSince(db, deviceHash, since) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM posts WHERE device_hash = ? AND created_at >= ?')
    .get(deviceHash, since);
  return Number(row.n);
}

export function countRate(db, { ipHash, action, since }) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE ip_hash = ? AND action = ? AND created_at >= ?')
    .get(ipHash, action, since);
  return Number(row.n);
}

export function addRate(db, { ipHash, action, now }) {
  db.prepare('INSERT INTO rate_events (ip_hash, action, created_at) VALUES (?, ?, ?)')
    .run(ipHash, action, now);
}

export function pruneRate(db, before) {
  db.prepare('DELETE FROM rate_events WHERE created_at < ?').run(before);
}

export function countCommentsByDeviceSince(db, deviceHash, since) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE device_hash = ? AND created_at >= ?')
    .get(deviceHash, since);
  return Number(row.n);
}

export function backupTo(db, path) {
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
}
