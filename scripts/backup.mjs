/**
 * 备份：把数据库整份拷到 data/backup-YYYY-MM-DD.db，只留最近 7 份。
 * 用法：node scripts/backup.mjs
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import * as store from '../src/db.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(root);
const stamp = new Date().toISOString().slice(0, 10);
const target = join(config.dataDir, `backup-${stamp}.db`);

const db = store.openDb(config.dbPath);
store.backupTo(db, target);
db.close();
console.log(`备份好了：${target}`);

const backups = readdirSync(config.dataDir)
  .filter((name) => /^backup-\d{4}-\d{2}-\d{2}\.db$/.test(name))
  .map((name) => ({ name, path: join(config.dataDir, name), mtime: statSync(join(config.dataDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

for (const old of backups.slice(7)) {
  unlinkSync(old.path);
  console.log(`删掉旧备份：${old.name}`);
}
