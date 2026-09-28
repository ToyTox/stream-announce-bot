import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

// Схема: broadcast — эфир, broadcast_stream — платформы этого эфира, setting — состояние бота.
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
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
