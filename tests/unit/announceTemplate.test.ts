import { describe, expect, it } from 'vitest';
import {
  CAPTION_LIMIT,
  DISCORD_DESCRIPTION_LIMIT,
  THANKS,
  formatDuration,
  customTextToMarkdown,
  renderAnnounce,
  renderDiscordAnnounce,
  renderDiscordFinished,
  renderFinished,
} from '../../src/announceTemplate.js';

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

describe('Discord', () => {
  it('анонс: маскированные ссылки и состав как в Telegram', () => {
    const text = renderDiscordAnnounce({ title: 'Стрим', game: 'Elden Ring', links });

    expect(text.startsWith('Всем привет\n\n🔴 **Стрим**\n🎮 Elden Ring')).toBe(true);
    expect(text).toContain('▶️ [Twitch](https://twitch.tv/me)');
    expect(text).toContain('▶️ [VK Live](https://live.vkvideo.ru/me)');
  });

  it('экранирует разметку и не даёт названию сломать ссылки', () => {
    const text = renderDiscordAnnounce({
      title: '**ЖИРНЫЙ** [клик](https://evil.test) @everyone',
      game: '# заголовок_',
      links: [{ label: 'My [site]', url: 'https://a.test/x_(y)' }],
    });

    expect(text).toContain('\\*\\*ЖИРНЫЙ\\*\\* \\[клик\\]\\(https://evil.test\\) @everyone');
    expect(text).toContain('🎮 \\# заголовок\\_');
    expect(text).toContain('[My \\[site\\]](https://a.test/x_%28y%29)');
  });

  it('итог эфира: длительность, благодарность, ссылки', () => {
    const text = renderDiscordFinished({ title: 'Стрим', durationMs: 150 * 60_000, links: [links[0]!] });

    expect(text).toContain('⚫️ **Стрим**');
    expect(text).toContain('длился 2 ч 30 мин');
    expect(text).toContain(THANKS);
    expect(text).toContain('[Twitch](https://twitch.tv/me)');
  });

  it('врезка — обычный текст: разметка и теги экранируются, как и в Telegram', () => {
    const text = renderDiscordAnnounce({
      title: 'Стрим',
      customText: 'Сегодня <b>финал</b> & *розыгрыш* [тут](https://evil.test) `код` @everyone',
      links: [links[0]!],
    });

    expect(text).toContain(
      'Сегодня \\<b\\>финал\\</b\\> & \\*розыгрыш\\* \\[тут\\]\\(https://evil.test\\) \\`код\\` @everyone'
    );
  });

  it('врезка в начале строки не превращается в список, заголовок или цитату', () => {
    const text = customTextToMarkdown('- пункт\n# заголовок\n> цитата\n+ плюс', 1000);

    expect(text).toBe('\\- пункт\n\\# заголовок\n\\> цитата\n\\+ плюс');
  });

  it('обрезает только врезку и укладывается в лимит описания', () => {
    const text = renderDiscordAnnounce({
      title: 'Стрим',
      game: 'Игра',
      customText: '*'.repeat(9000),
      links,
    });

    expect(text.length).toBeLessThanOrEqual(DISCORD_DESCRIPTION_LIMIT);
    expect(text).toContain('…\n\n▶️ [Twitch]');
    expect(text.startsWith('Всем привет\n\n🔴 **Стрим**\n🎮 Игра\n\n\\*')).toBe(true);
    expect(text.endsWith('[VK Live](https://live.vkvideo.ru/me)')).toBe(true);
  });

  it('обрезка не рвёт экранирование и суррогатные пары', () => {
    const text = customTextToMarkdown('😀*'.repeat(100), 21);

    expect(text.length).toBeLessThanOrEqual(21);
    expect(text).toMatch(/^(😀\\\*)+…$/u);
  });
});

describe('английский язык анонса', () => {
  const en = { language: 'en' };

  it('Telegram: приветствие на английском, название и врезка как есть', () => {
    const text = renderAnnounce({ title: 'Вечерний стрим', customText: 'Сегодня финал', links: [links[0]!], ...en });

    expect(text.split('\n').slice(0, 3)).toEqual(['Hello everyone', '', '🔴 <b>Вечерний стрим</b>']);
    expect(text).toContain('Сегодня финал');
  });

  it('Telegram: итог эфира', () => {
    const text = renderFinished({ title: 'Stream', durationMs: 135 * 60_000, links: [links[0]!], ...en });

    expect(text).toContain('Stream ended, it lasted 2 h 15 min');
    expect(text).toContain('Thanks to everyone who dropped by the stream, you can watch the replay here:');
    expect(text).not.toContain('Эфир завершён');
  });

  it('Telegram: врезка обрезается по лимиту подписи', () => {
    const text = renderAnnounce({ title: 'Stream', customText: 'a'.repeat(3000), links, ...en });

    expect(text.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(text.startsWith('Hello everyone')).toBe(true);
    expect(text).toContain('…');
    expect(text).toContain('VK Live');
  });

  it('Discord: анонс и итог эфира', () => {
    const announce = renderDiscordAnnounce({ title: 'Stream', game: 'Elden Ring', links: [links[0]!], ...en });
    const finished = renderDiscordFinished({ title: 'Stream', durationMs: 45 * 60_000, links: [links[0]!], ...en });

    expect(announce.startsWith('Hello everyone\n\n🔴 **Stream**\n🎮 Elden Ring')).toBe(true);
    expect(finished).toContain('Stream ended, it lasted 45 min');
    expect(finished).toContain('Thanks to everyone who dropped by the stream');
    expect(finished).toContain('[Twitch](https://twitch.tv/me)');
  });

  it('Discord: врезка обрезается по лимиту описания', () => {
    const text = renderDiscordAnnounce({ title: 'Stream', customText: '*'.repeat(9000), links, ...en });

    expect(text.length).toBeLessThanOrEqual(DISCORD_DESCRIPTION_LIMIT);
    expect(text.startsWith('Hello everyone')).toBe(true);
    expect(text.endsWith('[VK Live](https://live.vkvideo.ru/me)')).toBe(true);
  });

  it('без языка остаётся русский', () => {
    expect(renderAnnounce({ title: 'Стрим', links }).startsWith('Всем привет')).toBe(true);
  });
});

describe('formatDuration: английский', () => {
  it.each([
    [45 * 60_000, '45 min'],
    [60 * 60_000, '1 h'],
    [95 * 60_000, '1 h 35 min'],
  ])('%i мс → %s', (ms, expected) => {
    expect(formatDuration(ms, 'en')).toBe(expected);
  });
});
