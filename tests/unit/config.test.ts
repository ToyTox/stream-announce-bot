import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const base = {
  TELEGRAM_BOT_TOKEN: 'token',
  TELEGRAM_CHAT_ID: '-1002241331974',
  TWITCH_LOGIN: 'me',
  TWITCH_CLIENT_ID: 'cid',
  TWITCH_CLIENT_SECRET: 'secret',
};

describe('loadConfig', () => {
  it('собирает конфиг с дефолтами', () => {
    const config = loadConfig(base);

    expect(config.telegram.chatId).toBe('-1002241331974');
    expect(config.telegram.topicId).toBeUndefined();
    expect(config.twitch).toEqual({ login: 'me', clientId: 'cid', clientSecret: 'secret' });
    expect(config.youtube).toBeUndefined();
    expect(config.announceGraceMs).toBe(90_000);
    expect(config.primaryPlatform).toBe('twitch');
    expect(config.announceEnd).toBe(true);
  });

  it('требует токен бота', () => {
    expect(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '' })).toThrow(ConfigError);
  });

  it('требует хотя бы одну платформу', () => {
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: '-100' })
    ).toThrow(/Не настроена ни одна платформа/);
  });

  it('ругается на половину параметров Twitch', () => {
    expect(() => loadConfig({ ...base, TWITCH_CLIENT_SECRET: '' })).toThrow(/заполнены не все/);
  });

  it('YouTube работает без ключа, с ключом — тоже', () => {
    expect(loadConfig({ ...base, YOUTUBE_CHANNEL_ID: 'UC1' }).youtube).toEqual({
      channelId: 'UC1',
      apiKey: undefined,
    });
    expect(loadConfig({ ...base, YOUTUBE_CHANNEL_ID: 'UC1', YOUTUBE_API_KEY: 'k' }).youtube?.apiKey).toBe('k');
  });

  it('проверяет PRIMARY_PLATFORM', () => {
    expect(() => loadConfig({ ...base, PRIMARY_PLATFORM: 'kick' })).toThrow(/PRIMARY_PLATFORM/);
  });

  it('читает числа и флаги', () => {
    const config = loadConfig({
      ...base,
      TELEGRAM_TOPIC_ID: '42',
      POLL_INTERVAL_MS: '30000',
      DRY_RUN: 'true',
      ANNOUNCE_END: 'false',
    });

    expect(config.telegram.topicId).toBe(42);
    expect(config.pollIntervalMs).toBe(30_000);
    expect(config.dryRun).toBe(true);
    expect(config.announceEnd).toBe(false);
  });
});
