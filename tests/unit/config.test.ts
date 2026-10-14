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

  describe('DISCORD_WEBHOOK_URL', () => {
    const hook = 'https://discord.com/api/webhooks/123456789/abc_DEF-123';

    it('пусто — Discord выключен', () => {
      expect(loadConfig(base).discord).toBeUndefined();
      expect(loadConfig({ ...base, DISCORD_WEBHOOK_URL: '  ' }).discord).toBeUndefined();
    });

    it('принимает вебхук Discord, включая ptb, canary и discordapp.com', () => {
      expect(loadConfig({ ...base, DISCORD_WEBHOOK_URL: hook }).discord).toEqual({ webhookUrl: hook });
      for (const host of ['ptb.discord.com', 'canary.discord.com', 'discordapp.com']) {
        const url = `https://${host}/api/webhooks/1/tok/`;
        expect(loadConfig({ ...base, DISCORD_WEBHOOK_URL: url }).discord?.webhookUrl).toBe(`https://${host}/api/webhooks/1/tok`);
      }
    });

    it.each([
      'not a url',
      'http://discord.com/api/webhooks/1/tok',
      'https://example.com/api/webhooks/1/tok',
      'https://discord.com.evil.test/api/webhooks/1/tok',
      'https://discord.com/api/webhooks/1',
      'https://discord.com/api/webhooks/x/tok',
      'https://discord.com/api/webhooks/1/tok?thread_id=5',
    ])('отклоняет %s и не раскрывает значение в ошибке', (value) => {
      const call = () => loadConfig({ ...base, DISCORD_WEBHOOK_URL: value });

      expect(call).toThrow(ConfigError);
      expect(call).toThrow(/DISCORD_WEBHOOK_URL/);
      expect(call).not.toThrow(/tok/);
    });
  });
});
