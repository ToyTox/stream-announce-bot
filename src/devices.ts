import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';

/**
 * Реестр устройств мобильного приложения. В базе лежит только SHA-256 токена:
 * открытый токен виден один раз, при выпуске.
 */

export interface DeviceRow {
  id: number;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface RawDevice {
  id: number;
  name: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** 32 случайных байта в base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isTokenFormat(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toDevice(row: RawDevice): DeviceRow {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export class DeviceStore {
  constructor(private readonly db: Db) {}

  /** Выпускает токен: возвращает его открытым, в базу пишет только хэш. */
  issue(name: string, now = Date.now()): { device: DeviceRow; token: string } {
    const token = randomBytes(32).toString('base64url');
    const result = this.db
      .prepare('INSERT INTO device (name, token_hash, created_at) VALUES (?, ?, ?)')
      .run(name, hashToken(token), now);
    const device: DeviceRow = { id: Number(result.lastInsertRowid), name, createdAt: now, lastUsedAt: null, revokedAt: null };
    return { device, token };
  }

  /** Действующее устройство по токену; неверный формат, неизвестный и отозванный токен дают undefined. */
  findByToken(token: string): DeviceRow | undefined {
    if (!isTokenFormat(token)) return undefined;
    const hash = hashToken(token);
    const row = this.db.prepare('SELECT * FROM device WHERE token_hash = ?').get(hash) as RawDevice | undefined;
    if (!row || row.revoked_at !== null) return undefined;
    // Хэши равной длины; сравнение без утечек по времени.
    if (!timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) return undefined;
    return toDevice(row);
  }

  /** Все устройства, включая отозванные; хэшей токенов в ответе нет. */
  list(): DeviceRow[] {
    return (this.db.prepare('SELECT * FROM device ORDER BY id').all() as RawDevice[]).map(toDevice);
  }

  /** Отзывает токен; false, если устройства нет или оно уже отозвано. */
  revoke(id: number, now = Date.now()): boolean {
    return this.db.prepare('UPDATE device SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes > 0;
  }

  touch(id: number, now = Date.now()): void {
    this.db.prepare('UPDATE device SET last_used_at = ? WHERE id = ?').run(now, id);
  }
}
