import { ANNOUNCE_HEAD_RESERVE, CAPTION_LIMIT, linksBlock } from './announceTemplate.js';
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

export type DeliveryState = 'pending' | 'sent' | 'failed';

/** Доставка анонса эфира на одну площадку. */
export interface DeliveryRow {
  broadcastId: number;
  channel: string;
  state: DeliveryState;
  sentAt: number | null;
  messageId: string | null;
  target: string | null;
  error: string | null;
}

interface RawDelivery {
  broadcast_id: number;
  channel: string;
  state: DeliveryState;
  sent_at: number | null;
  message_id: string | null;
  target: string | null;
  error: string | null;
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

function toDelivery(row: RawDelivery): DeliveryRow {
  return {
    broadcastId: row.broadcast_id,
    channel: row.channel,
    state: row.state,
    sentAt: row.sent_at,
    messageId: row.message_id,
    target: row.target,
    error: row.error,
  };
}

export const SETTING_ANNOUNCE_TEXT = 'announce_text';
export const SETTING_UPDATES_OFFSET = 'updates_offset';
export const SETTING_ANNOUNCE_PHOTO = 'announce_photo';
export const SETTING_STATIC_LINKS = 'static_links';
export const SETTING_LINKS_SNAPSHOT = 'announce_links_snapshot';

/** Ссылка из списка пользователя; always — «всегда в анонсе». Порядок в списке = порядок в анонсе. */
export interface StaticLink {
  label: string;
  url: string;
  always: boolean;
}

/** Ссылки анонса, зафиксированные на первой доставке эфира; links = null — анонс шёл с живыми стримами. */
export interface LinksSnapshot {
  broadcastId: number;
  links: Array<{ label: string; url: string }> | null;
}

export const MAX_STATIC_LINKS = 20;
export const MAX_LINK_LABEL = 64;
export const MAX_LINK_URL = 512;

/** Ошибка проверки списка ссылок: key — ключ словаря, чтобы показать текст на языке запроса. */
export class StaticLinksError extends Error {
  constructor(
    message: string,
    readonly key: string,
    readonly params?: Record<string, string | number>
  ) {
    super(message);
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** Проверяет весь список целиком: при любой ошибке бросает StaticLinksError, ничего не сохраняя. */
export function validateStaticLinks(value: unknown): StaticLink[] {
  if (!Array.isArray(value)) throw new StaticLinksError('Ожидается массив ссылок', 'server.links.notArray');
  if (value.length > MAX_STATIC_LINKS) {
    throw new StaticLinksError(`Ссылок не больше ${MAX_STATIC_LINKS}`, 'server.links.tooMany', { max: MAX_STATIC_LINKS });
  }
  return value.map((item, index): StaticLink => {
    const n = index + 1;
    if (!item || typeof item !== 'object') throw new StaticLinksError(`Ссылка ${n}: ожидается объект`, 'server.links.badItem', { n });
    const { label, url, always } = item as Record<string, unknown>;
    const cleanLabel = typeof label === 'string' ? label.trim() : '';
    const cleanUrl = typeof url === 'string' ? url.trim() : '';
    if (!cleanLabel) throw new StaticLinksError(`Ссылка ${n}: название не заполнено`, 'server.links.emptyLabel', { n });
    if (cleanLabel.length > MAX_LINK_LABEL) {
      throw new StaticLinksError(`Ссылка ${n}: название длиннее ${MAX_LINK_LABEL} символов`, 'server.links.longLabel', { n, max: MAX_LINK_LABEL });
    }
    if (cleanUrl.length > MAX_LINK_URL) {
      throw new StaticLinksError(`Ссылка ${n}: адрес длиннее ${MAX_LINK_URL} символов`, 'server.links.longUrl', { n, max: MAX_LINK_URL });
    }
    if (!isAbsoluteHttpUrl(cleanUrl)) {
      throw new StaticLinksError(`Ссылка ${n}: нужен полный адрес http:// или https://`, 'server.links.badUrl', { n });
    }
    if (always !== undefined && typeof always !== 'boolean') {
      throw new StaticLinksError(`Ссылка ${n}: отметка «всегда в анонсе» должна быть true или false`, 'server.links.badAlways', { n });
    }
    return { label: cleanLabel, url: cleanUrl, always: always === true };
  });
}

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

  /** Эфир считается анонсированным с первой доставки на любую площадку; врезка фиксируется тогда же. */
  markAnnounced(broadcastId: number, now: number, announceText: string | null): void {
    this.db
      .prepare(
        'UPDATE broadcast SET announced_at = COALESCE(announced_at, ?), announce_text = COALESCE(announce_text, ?) WHERE id = ?'
      )
      .run(now, announceText, broadcastId);
  }

  deliveriesOf(broadcastId: number): DeliveryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM broadcast_delivery WHERE broadcast_id = ? ORDER BY rowid')
      .all(broadcastId) as RawDelivery[];
    return rows.map(toDelivery);
  }

  /** Заводит доставку «ждёт отправки» для площадок, включённых на момент анонса. Вызывается один раз на эфир. */
  startDeliveries(broadcastId: number, channels: string[]): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO broadcast_delivery (broadcast_id, channel, state) VALUES (?, ?, 'pending')"
    );
    for (const channel of channels) insert.run(broadcastId, channel);
  }

  markDelivered(
    broadcastId: number,
    channel: string,
    now: number,
    messageId: string | null,
    target: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE broadcast_delivery SET state = 'sent', sent_at = ?, message_id = ?, target = ?, error = NULL
         WHERE broadcast_id = ? AND channel = ?`
      )
      .run(now, messageId, target, broadcastId, channel);
  }

  /** Постоянный отказ площадки: больше не повторяем. */
  markDeliveryFailed(broadcastId: number, channel: string, error: string): void {
    this.db
      .prepare("UPDATE broadcast_delivery SET state = 'failed', error = ? WHERE broadcast_id = ? AND channel = ?")
      .run(error, broadcastId, channel);
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

  /** Список ссылок пользователя в его порядке. Битая запись в базе читается как пустой список. */
  staticLinks(): StaticLink[] {
    const raw = this.getSetting(SETTING_STATIC_LINKS);
    if (raw === null) return [];
    try {
      return validateStaticLinks(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  /** Заменяет список целиком; при некорректных данных бросает StaticLinksError и не трогает сохранённое. */
  setStaticLinks(value: unknown, now: number = Date.now()): StaticLink[] {
    const links = validateStaticLinks(value);
    // Размер проверяем только при сохранении: старый список в базе остаётся читаемым, а анонс подстрахован в renderAnnounce.
    const always = links.filter((link) => link.always);
    const maxBlock = CAPTION_LIMIT - ANNOUNCE_HEAD_RESERVE;
    if (linksBlock(always).length > maxBlock) {
      throw new StaticLinksError(`Отмеченные ссылки не помещаются в подпись (до ${maxBlock} символов)`, 'server.links.tooLong', { max: maxBlock });
    }
    this.setSetting(SETTING_STATIC_LINKS, JSON.stringify(links), now);
    return links;
  }

  /** Отмеченные «всегда в анонсе» ссылки; если они есть, анонс берёт только их. */
  alwaysLinks(): StaticLink[] {
    return this.staticLinks().filter((link) => link.always);
  }

  linksSnapshot(broadcastId: number): LinksSnapshot | null {
    const raw = this.getSetting(SETTING_LINKS_SNAPSHOT);
    if (raw === null) return null;
    try {
      const snapshot = JSON.parse(raw) as LinksSnapshot;
      return snapshot.broadcastId === broadcastId ? snapshot : null;
    } catch {
      return null;
    }
  }

  setLinksSnapshot(snapshot: LinksSnapshot, now: number = Date.now()): void {
    this.setSetting(SETTING_LINKS_SNAPSHOT, JSON.stringify(snapshot), now);
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
