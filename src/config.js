/**
 * Configuration loading. `config/*.json` holds the editable, non-secret settings;
 * `data/secret.json` is generated on first run and holds the shared passphrase,
 * the admin passphrase and the signing secret. It is gitignored and chmod 600.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pick(list) {
  return list[randomInt(0, list.length)];
}

/** Human-typeable passphrase such as `核桃-星轨-41`. */
export function makePhrase(words) {
  return `${pick(words.suffix)}-${pick(words.suffix)}-${randomInt(10, 100)}`;
}

/**
 * @param {string} root project directory holding `config/`
 * @param {{dataDir?: string}} [options] data directory override (tests use a temp dir)
 */
export function loadConfig(root, options = {}) {
  const app = readJson(join(root, 'config/app.json'));
  const words = readJson(join(root, 'config/words.json'));
  const keywords = readJson(join(root, 'config/keywords.json'));
  const dataDir = options.dataDir ?? join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  const secretPath = join(dataDir, 'secret.json');
  let credentials;
  let generated = false;
  if (existsSync(secretPath)) {
    credentials = readJson(secretPath);
  } else {
    credentials = {
      secret: randomBytes(32).toString('hex'),
      passphrase: makePhrase(words),
      adminPassphrase: makePhrase(words),
      createdAt: Date.now()
    };
    writeFileSync(secretPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    generated = true;
  }

  return {
    root,
    dataDir,
    dbPath: join(dataDir, 'treehole.db'),
    app,
    words,
    keywords,
    credentials,
    credentialsGenerated: generated
  };
}
