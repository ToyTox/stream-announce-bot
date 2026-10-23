import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db.js';
import { DeviceStore } from '../../src/devices.js';

let dir: string;
let db: Db;
let devices: DeviceStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stream-bot-devices-'));
  db = openDb(join(dir, 'bot.db'));
  devices = new DeviceStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('устройства', () => {
  it('выпуск возвращает токен, а в базе нет открытого токена', () => {
    const { device, token } = devices.issue('Pixel', 1000);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(device).toMatchObject({ name: 'Pixel', createdAt: 1000, lastUsedAt: null, revokedAt: null });
    const rows = db.prepare('SELECT * FROM device').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('токены разных устройств различаются', () => {
    expect(devices.issue('a').token).not.toBe(devices.issue('b').token);
  });

  it('находит устройство по верному токену', () => {
    const { device, token } = devices.issue('Pixel');

    expect(devices.findByToken(token)).toEqual(device);
  });

  it('не находит по неверному токену и по кривому формату', () => {
    devices.issue('Pixel');

    expect(devices.findByToken('A'.repeat(43))).toBeUndefined();
    expect(devices.findByToken('короткий')).toBeUndefined();
    expect(devices.findByToken('')).toBeUndefined();
  });

  it('не находит отозванное устройство; повторный отзыв ничего не меняет', () => {
    const { device, token } = devices.issue('Pixel');

    expect(devices.revoke(device.id, 2000)).toBe(true);
    expect(devices.revoke(device.id, 3000)).toBe(false);
    expect(devices.findByToken(token)).toBeUndefined();
    expect(devices.list()[0]?.revokedAt).toBe(2000);
    expect(devices.revoke(999)).toBe(false);
  });

  it('список без хэшей, touch обновляет время последнего использования', () => {
    const { device } = devices.issue('Pixel', 1000);
    devices.touch(device.id, 5000);

    const [listed] = devices.list();
    expect(listed).toEqual({ id: device.id, name: 'Pixel', createdAt: 1000, lastUsedAt: 5000, revokedAt: null });
    expect(JSON.stringify(devices.list())).not.toContain('hash');
  });

  it('таблица создаётся на старой базе, данные не затронуты', () => {
    const path = join(dir, 'old.db');
    const old = new Database(path);
    old.exec('CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    old.prepare("INSERT INTO setting (key, value, updated_at) VALUES ('announce_text', 'врезка', 1)").run();
    old.close();

    const migrated = openDb(path);
    expect(new DeviceStore(migrated).list()).toEqual([]);
    expect(migrated.prepare('SELECT value FROM setting').get()).toEqual({ value: 'врезка' });
    migrated.close();
  });
});
