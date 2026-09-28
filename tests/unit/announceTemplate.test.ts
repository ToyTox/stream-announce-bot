import { describe, expect, it } from 'vitest';
import { CAPTION_LIMIT, formatDuration, renderAnnounce } from '../../src/announceTemplate.js';

const links = [
  { platform: 'twitch' as const, url: 'https://twitch.tv/me' },
  { platform: 'youtube' as const, url: 'https://www.youtube.com/watch?v=abc' },
  { platform: 'vkvideo' as const, url: 'https://live.vkvideo.ru/me' },
];

describe('renderAnnounce', () => {
  it('одна платформа — одна ссылка', () => {
    const text = renderAnnounce({ title: 'Стрим', links: [links[0]!] });

    expect(text).toContain('<a href="https://twitch.tv/me">Twitch</a>');
    expect(text).not.toContain('YouTube');
    expect(text).not.toContain('VK Video');
  });

  it('три платформы — три ссылки в одном сообщении', () => {
    const text = renderAnnounce({ title: 'Стрим', game: 'Elden Ring', links });

    expect(text).toContain('Twitch');
    expect(text).toContain('YouTube');
    expect(text).toContain('VK Video');
    expect(text).toContain('🎮 Elden Ring');
    expect(text.match(/▶️/g)).toHaveLength(1);
  });

  it('подставляет врезку', () => {
    const text = renderAnnounce({
      title: 'Стрим',
      customText: 'Сегодня добиваем сюжетку',
      links: [links[0]!],
    });

    expect(text).toContain('Сегодня добиваем сюжетку');
  });

  it('экранирует HTML в заголовке и игре', () => {
    const text = renderAnnounce({
      title: 'Каток & <болталка>',
      game: 'A & B',
      links: [links[0]!],
    });

    expect(text).toContain('Каток &amp; &lt;болталка&gt;');
    expect(text).toContain('A &amp; B');
  });

  it('обрезает длинную врезку по лимиту подписи', () => {
    const text = renderAnnounce({
      title: 'Стрим',
      customText: 'а'.repeat(3000),
      links,
    });

    expect(text.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(text).toContain('…');
    expect(text).toContain('Twitch');
  });

  it('после окончания эфира показывает длительность вместо ссылок', () => {
    const text = renderAnnounce({
      title: 'Стрим',
      links: [],
      endedAfterMs: 2 * 60 * 60 * 1000 + 15 * 60 * 1000,
    });

    expect(text).toContain('Эфир завершён, длился 2 ч 15 мин');
    expect(text).not.toContain('▶️');
  });
});

describe('formatDuration', () => {
  it.each([
    [59_000, '1 мин'],
    [45 * 60_000, '45 мин'],
    [60 * 60_000, '1 ч'],
    [95 * 60_000, '1 ч 35 мин'],
  ])('%i мс → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
