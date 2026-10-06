import type { Db } from './db.js';
import { isPlatform, LiveStream, Platform } from './types.js';

/**
 * Репозиторий поверх SQLite. Состояние держим в базе, а не в памяти, чтобы
 * рестарт посреди эфира не привёл к повторному анонсу.
 */

export interface BroadcastRow {
  id: number;
  startedAt: number;
  announcedAt: number | null;
  endedAt: number | null;
  lastLiveAt: number;
  chatId: string | null;
  messageId: number | null;
  announceText: string | null;
}

export interface BroadcastStreamRow {
  id: number;
  broadcastId: number;
  platform: Platform;
  externalId: string;
  title: string | null;
  game: string | null;
  url: string;
  thumbnailUrl: string | null;
  startedAt: number;
  endedAt: number | null;
}

interface RawBroadcast {
  id: number;
  started_at: number;
  announced_at: number | null;
  ended_at: number | null;
  last_live_at: number;
  chat_id: string | null;
  message_id: number | null;
  announce_text: string | null;
}

interface RawStream {
  id: number;
  broadcast_id: number;
  platform: string;
  external_id: string;
  title: string | null;
  game: string | null;
  url: string;
  thumbnail_url: string | null;
  started_at: number;
  ended_at: number | null;
}

function toBroadcast(row: RawBroadcast): BroadcastRow {
  return {
    id: row.id,
    startedAt: row.started_at,
    announcedAt: row.announced_at,
    endedAt: row.ended_at,
    lastLiveAt: row.last_live_at,
    chatId: row.chat_id,
    messageId: row.message_id,
    announceText: row.announce_text,
  };
}

function toStream(row: RawStream): BroadcastStreamRow {
  // Платформа пишется только нашим кодом; на всякий случай не даём мусору из базы
  // просочиться в типизированный слой.
  if (!isPlatform(row.platform)) {
    throw new Error(`Неизвестная платформа в базе: ${row.platform}`);
  }
  return {
    id: row.id,
    broadcastId: row.broadcast_id,
    platform: row.platform,
    externalId: row.external_id,
    title: row.title,
    game: row.game,
    url: row.url,
    thumbnailUrl: row.thumbnail_url,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export const SETTING_ANNOUNCE_TEXT = 'announce_text';
export const SETTING_UPDATES_OFFSET = 'updates_offset';
export const SETTING_ANNOUNCE_PHOTO = 'announce_photo';

export class Store {
  constructor(private readonly db: Db) {}

  /** Открытый эфир всегда один: следующий создаётся только после закрытия предыдущего. */
  openBroadcast(): BroadcastRow | null {
    const row = this.db
      .prepare('SELECT * FROM broadcast WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get() as RawBroadcast | undefined;
    return row ? toBroadcast(row) : null;
  }

  createBroadcast(now: number): BroadcastRow {
    const result = this.db
      .prepare('INSERT INTO broadcast (started_at, last_live_at) VALUES (?, ?)')
      .run(now, now);
    const row = this.db
      .prepare('SELECT * FROM broadcast WHERE id = ?')
      .get(result.lastInsertRowid as number) as RawBroadcast;
    return toBroadcast(row);
  }

  touchBroadcast(broadcastId: number, now: number): void {
    this.db.prepare('UPDATE broadcast SET last_live_at = ? WHERE id = ?').run(now, broadcastId);
  }

  markAnnounced(
    broadcastId: number,
    now: number,
    chatId: string,
    messageId: number | null,
    announceText: string | null
  ): void {
    this.db
      .prepare(
        'UPDATE broadcast SET announced_at = ?, chat_id = ?, message_id = ?, announce_text = ? WHERE id = ?'
      )
      .run(now, chatId, messageId, announceText, broadcastId);
  }

  endBroadcast(broadcastId: number, now: number): void {
    this.db.prepare('UPDATE broadcast SET ended_at = ? WHERE id = ?').run(now, broadcastId);
    this.db
      .prepare('UPDATE broadcast_stream SET ended_at = ? WHERE broadcast_id = ? AND ended_at IS NULL')
      .run(now, broadcastId);
  }

  streamsOf(broadcastId: number): BroadcastStreamRow[] {
    const rows = this.db
      .prepare('SELECT * FROM broadcast_stream WHERE broadcast_id = ? ORDER BY id')
      .all(broadcastId) as RawStream[];
    return rows.map(toStream);
  }

  /** Платформы, которые прямо сейчас в эфире внутри этого броадкаста. */
  liveStreamsOf(broadcastId: number): BroadcastStreamRow[] {
    return this.streamsOf(broadcastId).filter((stream) => stream.endedAt === null);
  }

  /**
   * Добавляет платформу в эфир или воскрешает её, если она отваливалась.
   * UNIQUE(broadcast_id, platform) гарантирует одну запись на площадку.
   */
  upsertStream(broadcastId: number, stream: LiveStream, now: number): void {
    const startedAt = stream.startedAt.getTime() || now;
    this.db
      .prepare(
        `INSERT INTO broadcast_stream
           (broadcast_id, platform, external_id, title, game, url, thumbnail_url, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (broadcast_id, platform) DO UPDATE SET
           external_id = excluded.external_id,
           title = excluded.title,
           game = excluded.game,
           url = excluded.url,
           thumbnail_url = excluded.thumbnail_url,
           ended_at = NULL`
      )
      .run(
        broadcastId,
        stream.platform,
        stream.externalId,
        stream.title,
        stream.game ?? null,
        stream.url,
        stream.thumbnailUrl ?? null,
        startedAt
      );
  }

  endStream(broadcastId: number, platform: Platform, now: number): void {
    this.db
      .prepare(
        'UPDATE broadcast_stream SET ended_at = ? WHERE broadcast_id = ? AND platform = ? AND ended_at IS NULL'
      )
      .run(now, broadcastId, platform);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM setting WHERE key = ?').run(key);
  }

  /** Врезка, заданная командой /text. Живёт до первого анонса. */
  announceText(): string | null {
    return this.getSetting(SETTING_ANNOUNCE_TEXT);
  }

  setAnnounceText(text: string, now: number = Date.now()): void {
    this.setSetting(SETTING_ANNOUNCE_TEXT, text, now);
  }

  clearAnnounceText(): void {
    this.deleteSetting(SETTING_ANNOUNCE_TEXT);
  }

  /** file_id картинки, присланной боту: заменяет превью Twitch во всех анонсах, пока её не сбросят. */
  announcePhoto(): string | null {
    return this.getSetting(SETTING_ANNOUNCE_PHOTO);
  }

  setAnnouncePhoto(fileId: string, now: number = Date.now()): void {
    this.setSetting(SETTING_ANNOUNCE_PHOTO, fileId, now);
  }

  clearAnnouncePhoto(): void {
    this.deleteSetting(SETTING_ANNOUNCE_PHOTO);
  }

  updatesOffset(): number | null {
    const raw = this.getSetting(SETTING_UPDATES_OFFSET);
    if (raw === null) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  }

  setUpdatesOffset(offset: number, now: number = Date.now()): void {
    this.setSetting(SETTING_UPDATES_OFFSET, String(offset), now);
  }
}
