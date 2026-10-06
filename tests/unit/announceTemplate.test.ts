import { describe, expect, it } from 'vitest';
import { CAPTION_LIMIT, formatDuration, renderAnnounce, renderFinished } from '../../src/announceTemplate.js';

const links = [
  { label: 'Twitch', url: 'https://twitch.tv/me' },
  { label: 'YouTube', url: 'https://www.youtube.com/watch?v=abc' },
  { label: 'VK Live', url: 'https://live.vkvideo.ru/me' },
];

describe('renderAnnounce', () => {
  it('одна платформа — одна ссылка', () => {
    const text = renderAnnounce({ title: 'Стрим', links: [links[0]!] });

    expect(text).toContain('<a href="https://twitch.tv/me">Twitch</a>');
    expect(text).not.toContain('YouTube');
    expect(text).not.toContain('VK Live');
  });

  it('три платформы — три ссылки в одном сообщении', () => {
    const text = renderAnnounce({ title: 'Стрим', game: 'Elden Ring', links });

    expect(text).toContain('Twitch');
    expect(text).toContain('YouTube');
    expect(text).toContain('VK Live');
    expect(text).toContain('🎮 Elden Ring');
  });

  it('начинается с приветствия и пустой строки после него', () => {
    const text = renderAnnounce({ title: 'Стрим', links });

    expect(text.split('\n').slice(0, 3)).toEqual(['Всем привет', '', '🔴 <b>Стрим</b>']);
  });

  it('ссылки идут столбцом, по строке на площадку', () => {
    const text = renderAnnounce({ title: 'Стрим', links });
    const linkLines = text.split('\n').filter((line) => line.startsWith('▶️'));

    expect(linkLines).toEqual([
      '▶️ <a href="https://twitch.tv/me">Twitch</a>',
      '▶️ <a href="https://www.youtube.com/watch?v=abc">YouTube</a>',
      '▶️ <a href="https://live.vkvideo.ru/me">VK Live</a>',
    ]);
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
});

describe('renderFinished', () => {
  const channels = [
    { label: 'Twitch', url: 'https://twitch.tv/me' },
    { label: 'YouTube', url: 'https://www.youtube.com/channel/UC123' },
    { label: 'VK Video', url: 'https://vkvideo.ru/@me' },
    { label: 'VK Live', url: 'https://live.vkvideo.ru/me' },
  ];

  it('итог без приветствия: тема, игра, длительность, благодарность и ссылки столбцом', () => {
    const text = renderFinished({
      title: 'Стрим',
      game: 'Elden Ring',
      durationMs: 2 * 60 * 60 * 1000 + 15 * 60 * 1000,
      links: channels,
    });

    expect(text).toBe(
      [
        '⚫️ <b>Стрим</b>',
        '🎮 Elden Ring',
        '',
        'Эфир завершён, длился 2 ч 15 мин',
        '',
        'Всем спасибо, кто забегал на стрим, повтор стрима можно посмотреть тут:',
        '',
        '▶️ <a href="https://twitch.tv/me">Twitch</a>',
        '▶️ <a href="https://www.youtube.com/channel/UC123">YouTube</a>',
        '▶️ <a href="https://vkvideo.ru/@me">VK Video</a>',
        '▶️ <a href="https://live.vkvideo.ru/me">VK Live</a>',
      ].join('\n')
    );
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
