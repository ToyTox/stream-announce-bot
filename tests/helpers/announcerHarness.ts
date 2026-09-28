import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { Announcer } from '../../src/announcer.js';
import type { Config } from '../../src/config.js';
import { openDb, type Db } from '../../src/db.js';
import { Store } from '../../src/store.js';
import type { TelegramClient } from '../../src/telegram/client.js';
import { LiveStream, Platform } from '../../src/types.js';
import { BaseWatcher } from '../../src/watchers/base.js';

/** Управляемые часы: grace-периоды меряются минутами, ждать их в тестах незачем. */
export class Clock {
  constructor(private value = Date.parse('2026-09-28T18:00:00Z')) {}

  now = (): number => this.value;

  advance(ms: number): void {
    this.value += ms;
  }
}

type WatcherState = LiveStream | null | Error;

/** Вотчер, чьё состояние задаёт тест: стрим, офлайн или ошибка проверки. */
export class FakeWatcher extends BaseWatcher {
  constructor(
    readonly platform: Platform,
    public state: WatcherState = null
  ) {
    super();
  }

  async fetchLive(): Promise<LiveStream | null> {
    if (this.state instanceof Error) throw this.state;
    return this.state;
  }
}

export function liveStream(platform: Platform, clock: Clock, overrides: Partial<LiveStream> = {}): LiveStream {
  const urls: Record<Platform, string> = {
    twitch: 'https://twitch.tv/me',
    youtube: 'https://www.youtube.com/watch?v=abc',
    vkvideo: 'https://live.vkvideo.ru/me',
  };
  return {
    platform,
    externalId: `${platform}-1`,
    title: 'Вечерний стрим',
    game: 'Elden Ring',
    url: urls[platform],
    thumbnailUrl: `https://cdn/${platform}.jpg`,
    startedAt: new Date(clock.now()),
    ...overrides,
  };
}

export function fakeTelegram() {
  // Сигнатуры с аргументами нужны, чтобы mock.calls были типизированы в тестах.
  return {
    sendMessage: vi.fn(async (_text: string) => ({ message_id: 100, chat: { id: '-100123' } })),
    sendPhoto: vi.fn(async (_photoUrl: string, _caption: string) => ({
      message_id: 100,
      chat: { id: '-100123' },
    })),
    editMessageCaption: vi.fn(async (_messageId: number, _caption: string) => undefined),
    editMessageText: vi.fn(async (_messageId: number, _text: string) => undefined),
    getUpdates: vi.fn(async () => []),
    sendTo: vi.fn(async () => undefined),
  };
}

export type FakeTelegram = ReturnType<typeof fakeTelegram>;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegram: { botToken: 'token', chatId: '-100123' },
    pollIntervalMs: 60_000,
    announceGraceMs: 90_000,
    offlineGraceMs: 180_000,
    primaryPlatform: 'twitch',
    editOnEnd: true,
    dryRun: false,
    databasePath: ':memory:',
    ...overrides,
  };
}

export interface Harness {
  clock: Clock;
  db: Db;
  store: Store;
  telegram: FakeTelegram;
  watchers: Record<Platform, FakeWatcher>;
  announcer: Announcer;
  /** Новый Announcer на той же базе — имитация рестарта процесса. */
  restart(): Announcer;
  cleanup(): void;
}

export function createHarness(configOverrides: Partial<Config> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'stream-bot-'));
  const dbPath = join(dir, 'test.db');
  const db = openDb(dbPath);
  const store = new Store(db);
  const clock = new Clock();
  const telegram = fakeTelegram();
  const config = testConfig(configOverrides);

  const watchers: Record<Platform, FakeWatcher> = {
    twitch: new FakeWatcher('twitch'),
    youtube: new FakeWatcher('youtube'),
    vkvideo: new FakeWatcher('vkvideo'),
  };
  const list = [watchers.twitch, watchers.youtube, watchers.vkvideo];

  const build = () =>
    new Announcer({
      store,
      watchers: list,
      telegram: telegram as unknown as TelegramClient,
      config,
      now: clock.now,
    });

  return {
    clock,
    db,
    store,
    telegram,
    watchers,
    announcer: build(),
    restart: build,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
