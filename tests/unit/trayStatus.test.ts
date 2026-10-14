import { describe, expect, it } from 'vitest';
import { trayStatus } from '../../desktop/trayStatus.js';

const startedAt = new Date(2026, 8, 28, 18, 5).getTime();

describe('trayStatus', () => {
  it('бот не запущен: причина обрезается, язык выбирается', () => {
    const reason = 'x'.repeat(120);

    expect(trayStatus(null, 'нет токена', 'ru')).toEqual({ state: 'stopped', lines: ['Бот не запущен: нет токена'] });
    expect(trayStatus(null, 'no token', 'en')).toEqual({ state: 'stopped', lines: ['The bot is not running: no token'] });
    expect(trayStatus(null, reason, 'en').lines[0]).toBe(`The bot is not running: ${'x'.repeat(90)}…`);
    expect(trayStatus(null, null, 'en').lines[0]).toBe('The bot is not running: unknown error');
  });

  it('эфира нет', () => {
    const bot = { dryRun: false, broadcast: null, failed: [] };

    expect(trayStatus(bot, null, 'ru')).toEqual({ state: 'idle', lines: ['Эфира нет'] });
    expect(trayStatus(bot, null, 'en')).toEqual({ state: 'idle', lines: ['Not live'] });
  });

  it('идёт эфир: время и площадки', () => {
    const bot = { dryRun: false, broadcast: { startedAt, platforms: ['twitch', 'vkvideo'] as const }, failed: [] };

    const ru = trayStatus({ ...bot, broadcast: { startedAt, platforms: [...bot.broadcast.platforms] } }, null, 'ru');
    const en = trayStatus({ ...bot, broadcast: { startedAt, platforms: [...bot.broadcast.platforms] } }, null, 'en');

    expect(ru.state).toBe('live');
    expect(ru.lines[0]).toMatch(/^● Эфир идёт с .+ · Twitch, VK Live$/);
    expect(en.lines[0]).toMatch(/^● Live since .+ · Twitch, VK Live$/);
  });

  it('тестовый режим и ошибка проверки дают предупреждение', () => {
    const dry = trayStatus({ dryRun: true, broadcast: null, failed: [] }, null, 'en');
    const failed = trayStatus({ dryRun: false, broadcast: null, failed: ['youtube'] }, null, 'en');

    expect(dry).toEqual({ state: 'warning', lines: ['Test mode'] });
    expect(failed).toEqual({ state: 'warning', lines: ['Not live', 'Check failed: YouTube'] });
    expect(trayStatus({ dryRun: false, broadcast: null, failed: ['youtube'] }, null, 'ru').lines[1]).toBe('Ошибка проверки: YouTube');
  });
});
