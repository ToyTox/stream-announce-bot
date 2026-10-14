import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';

/** База версии до доставки по площадкам: в broadcast есть announced_at, chat_id, message_id, но нет broadcast_delivery. */
const OLD_SCHEMA = `
CREATE TABLE broadcast (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL, announced_at INTEGER, ended_at INTEGER, last_live_at INTEGER NOT NULL,
  chat_id TEXT, message_id INTEGER, announce_text TEXT
);
CREATE TABLE broadcast_stream (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id INTEGER NOT NULL REFERENCES broadcast(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, external_id TEXT NOT NULL,
  title TEXT, game TEXT, url TEXT NOT NULL, thumbnail_url TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  UNIQUE (broadcast_id, platform)
);
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stream-bot-migration-'));
  path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(OLD_SCHEMA);
  old.prepare("INSERT INTO setting (key, value, updated_at) VALUES ('announce_text', 'врезка', 1)").run();
  // Два закрытых анонсированных эфира.
  old.exec(`
    INSERT INTO broadcast (started_at, announced_at, ended_at, last_live_at, chat_id, message_id, announce_text)
      VALUES (1000, 2000, 5000, 4000, '-100123', 77, 'старая врезка');
    INSERT INTO broadcast (started_at, announced_at, ended_at, last_live_at, chat_id, message_id)
      VALUES (6000, 7000, 8000, 7500, '-100123', 78);
  `);
  old.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('миграция базы без таблицы доставки', () => {
  it('анонсированные эфиры считаются доставленными в Telegram, остальные данные целы', () => {
    const db = openDb(path);
    const store = new Store(db);

    const [first] = store.deliveriesOf(1);
    expect(store.deliveriesOf(1)).toHaveLength(1);
    expect(first).toMatchObject({ channel: 'telegram', state: 'sent', sentAt: 2000, messageId: '77', target: '-100123' });
    expect(store.deliveriesOf(2)[0]).toMatchObject({ channel: 'telegram', state: 'sent', messageId: '78' });
    expect(store.getSetting('announce_text')).toBe('врезка');
    expect(db.prepare('SELECT announce_text FROM broadcast WHERE id = 1').get()).toEqual({ announce_text: 'старая врезка' });
    db.close();
  });

  it('открытый анонсированный эфир не получает Discord-анонс, а повторное открытие ничего не дублирует', () => {
    const old = new Database(path);
    old.exec("INSERT INTO broadcast (started_at, announced_at, last_live_at, chat_id, message_id) VALUES (9000, 9500, 9500, '-100123', 79)");
    old.close();

    openDb(path).close();
    const db = openDb(path);
    const store = new Store(db);

    const open = store.openBroadcast();
    expect(open?.id).toBe(3);
    expect(store.deliveriesOf(3).map((row) => [row.channel, row.state])).toEqual([['telegram', 'sent']]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM broadcast_delivery').get()).toEqual({ n: 3 });
    db.close();
  });

  it('эфир без анонса остаётся без записей доставки', () => {
    const old = new Database(path);
    old.exec('INSERT INTO broadcast (started_at, last_live_at) VALUES (9000, 9000)');
    old.close();

    const db = openDb(path);
    expect(new Store(db).deliveriesOf(3)).toEqual([]);
    db.close();
  });
});
