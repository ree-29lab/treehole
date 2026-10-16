/**
 * 预置内容：站点上线时不能是空的，否则来人看一眼就走。
 * 用法：node scripts/seed.mjs [--force]
 * 只在数据库里没有帖子时插入；--force 会无视这一点再插一遍。
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import * as store from '../src/db.js';
import { displayCode } from '../src/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(root);
const db = store.openDb(config.dbPath);
const force = process.argv.includes('--force');

if (!force && store.listPosts(db, { limit: 1 }).length > 0) {
  console.log('数据库里已经有内容了，跳过。要强制再插一份，加 --force。');
  process.exit(0);
}

const seeds = JSON.parse(readFileSync(join(root, 'config/seed-posts.json'), 'utf8'));
const seedDevice = () => `seed${randomBytes(6).toString('hex')}`;

let now = Date.now() - seeds.length * 5 * 3600 * 1000;
let postCount = 0;
let replyCount = 0;

for (const seed of seeds) {
  const deviceHash = seedDevice();
  const id = store.createPost(db, {
    body: seed.body,
    mood: seed.mood ?? '',
    code: '……',
    deviceHash,
    crisis: false,
    now
  });
  store.setPostCode(db, id, displayCode(config.words, deviceHash, id));
  postCount += 1;

  for (const reply of seed.replies ?? []) {
    now += 4 * 60 * 1000;
    store.createComment(db, {
      postId: id,
      parentId: null,
      body: reply.body,
      code: displayCode(config.words, seedDevice(), id),
      deviceHash: seedDevice(),
      crisis: false,
      now
    });
    replyCount += 1;
  }

  now += 3 * 3600 * 1000;
}

console.log(`放进去 ${postCount} 条树洞、${replyCount} 条回应。`);
db.close();
