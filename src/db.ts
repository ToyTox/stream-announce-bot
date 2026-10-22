import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

// Схема: broadcast — эфир, broadcast_stream — платформы этого эфира, broadcast_delivery — доставка анонса
// по площадкам (Telegram, Discord), setting — состояние бота, device — устройства мобильного приложения.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS broadcast (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,   -- когда первая платформа замечена в эфире
  announced_at INTEGER,            -- NULL = сообщение ещё не отправлено (идёт grace-период)
  ended_at     INTEGER,            -- NULL = эфир открыт; открытый эфир всегда один
  last_live_at INTEGER NOT NULL,   -- последний момент, когда хоть одна платформа была live
  chat_id TEXT, message_id INTEGER,
  announce_text TEXT               -- врезка, зафиксированная на момент анонса
);
CREATE TABLE IF NOT EXISTS broadcast_stream (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id INTEGER NOT NULL REFERENCES broadcast(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,          -- twitch | youtube | vkvideo
  external_id TEXT NOT NULL,       -- id трансляции/видео у платформы
  title TEXT, game TEXT, url TEXT NOT NULL, thumbnail_url TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  UNIQUE (broadcast_id, platform)
);
CREATE TABLE IF NOT EXISTS broadcast_delivery (
  broadcast_id INTEGER NOT NULL REFERENCES broadcast(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,           -- telegram | discord
  state TEXT NOT NULL,             -- pending | sent | failed (отказ после постоянной ошибки)
  sent_at INTEGER,
  message_id TEXT,                 -- у Telegram число, у Discord строка-snowflake
  target TEXT,                     -- куда ушло: у Telegram id чата
  error TEXT,
  PRIMARY KEY (broadcast_id, channel)
);
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS device (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, -- SHA-256 токена; сам токен в базе не хранится
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER               -- NULL = токен действует
);
`;

// Эфиры, анонсированные до появления таблицы доставки, считаются доставленными в Telegram:
// в Discord они не уходят. Повторный запуск ничего не меняет: у таких эфиров уже есть записи.
const MIGRATE_DELIVERIES = `
INSERT INTO broadcast_delivery (broadcast_id, channel, state, sent_at, message_id, target)
SELECT b.id, 'telegram', 'sent', b.announced_at, CAST(b.message_id AS TEXT), b.chat_id
FROM broadcast b
WHERE b.announced_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM broadcast_delivery d WHERE d.broadcast_id = b.id);
`;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.exec(MIGRATE_DELIVERIES);
  return db;
}
