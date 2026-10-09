import { describe, expect, it } from 'vitest';
import { formatEnvValue, updateEnvContent } from '../../src/web/envFile.js';
import { settingsChanges, settingsView } from '../../src/web/settings.js';

describe('updateEnvContent', () => {
  it('меняет значения на месте, сохраняя комментарии и порядок', () => {
    const before = ['# Telegram', 'TELEGRAM_CHAT_ID=-100123', '', '# Опрос, мс', 'POLL_INTERVAL_MS=60000', ''].join('\n');

    const after = updateEnvContent(before, { POLL_INTERVAL_MS: '30000' });

    expect(after).toBe(['# Telegram', 'TELEGRAM_CHAT_ID=-100123', '', '# Опрос, мс', 'POLL_INTERVAL_MS=30000', ''].join('\n'));
  });

  it('дописывает новые ключи в конец', () => {
    expect(updateEnvContent('A=1\n', { B: '2' })).toBe('A=1\nB=2\n');
    expect(updateEnvContent('', { B: '2' })).toBe('B=2\n');
  });

  it('берёт значение в кавычки, только когда без них dotenv прочитает иначе', () => {
    expect(formatEnvValue('https://vkvideo.ru/@me')).toBe('https://vkvideo.ru/@me');
    expect(formatEnvValue('a b')).toBe("'a b'");
    expect(formatEnvValue('x#y')).toBe("'x#y'");
    expect(formatEnvValue(`it's`)).toBe(`"it's"`);
  });
});

describe('settings', () => {
  it('секреты в браузер уходят замаскированными', () => {
    const view = settingsView({ TELEGRAM_BOT_TOKEN: '7712345678:AAHkSECRETxYz' });
    const token = view.find((field) => field.key === 'TELEGRAM_BOT_TOKEN')!;

    expect(token.isSet).toBe(true);
    expect(token.value).toBe('7712…xYz');
    expect(token.value).not.toContain('SECRET');
  });

  it('пустой секрет, незнакомые ключи и значения по умолчанию — не изменения', () => {
    const changes = settingsChanges(
      { TELEGRAM_BOT_TOKEN: '', EVIL: 'x', PRIMARY_PLATFORM: 'twitch', DRY_RUN: 'false', TELEGRAM_CHAT_ID: '-100999' },
      { TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: '-100123' }
    );

    expect(changes).toEqual({ TELEGRAM_CHAT_ID: '-100999' });
  });
});
