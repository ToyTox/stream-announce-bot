import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnouncerEvent } from '../../src/announcer.js';
import { DiscordError } from '../../src/discord/client.js';
import { TelegramError } from '../../src/telegram/client.js';
import { createHarness, liveStream, type Harness } from '../helpers/announcerHarness.js';

/**
 * Суть задачи: на эфир уходит ровно одно сообщение, в нём ссылки только на живые
 * площадки, а поздно подключившаяся платформа дописывается правкой.
 */

const MINUTE = 60_000;

let harness: Harness;

function caption(): string {
  return harness.telegram.sendPhoto.mock.calls[0]?.[1] ?? '';
}

/** Прогоняет тики так, чтобы суммарно прошло указанное время. */
async function run(minutes: number): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    harness.clock.advance(MINUTE);
    await harness.announcer.tick();
  }
}

beforeEach(() => {
  harness = createHarness();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  harness.cleanup();
});

describe('Announcer', () => {
  it('в эфире только Twitch — одно сообщение с одной ссылкой', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    await harness.announcer.tick();
    expect(harness.telegram.sendPhoto).not.toHaveBeenCalled(); // идёт grace-период

    await run(2);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(caption()).toContain('Twitch');
    expect(caption()).not.toContain('YouTube');
    expect(caption()).not.toContain('VK Live');
  });

  it('две платформы стартовали разом — одно сообщение с двумя ссылками', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    harness.watchers.youtube.state = liveStream('youtube', harness.clock);

    await run(3);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(caption()).toContain('Twitch');
    expect(caption()).toContain('YouTube');
  });

  it('платформа подключилась после анонса — анонс не трогаем и второго не шлём', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(3);
    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);

    harness.watchers.vkvideo.state = liveStream('vkvideo', harness.clock);
    await run(2);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
    expect(harness.telegram.editMessageCaption).not.toHaveBeenCalled();
    expect(harness.telegram.editMessageText).not.toHaveBeenCalled();
  });

  it('площадка упала после анонса — ссылки в анонсе остаются', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    harness.watchers.youtube.state = liveStream('youtube', harness.clock);
    await run(3);

    harness.watchers.youtube.state = null;
    await run(2);

    expect(harness.telegram.editMessageCaption).not.toHaveBeenCalled();
    expect(harness.telegram.editMessageText).not.toHaveBeenCalled();
    expect(caption()).toContain('YouTube');
  });

  it('за длинный эфир отправляет ровно одно сообщение и не правит его вхолостую', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    await run(15);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.telegram.editMessageCaption).not.toHaveBeenCalled();
  });

  it('платформа моргнула на один тик — эфир не закрывается, нового сообщения нет', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(3);

    harness.watchers.twitch.state = null;
    await run(1);
    harness.watchers.twitch.state = liveStream('twitch', harness.clock, { externalId: 'twitch-2' });
    await run(1);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.store.openBroadcast()).not.toBeNull();
  });

  it('все офлайн дольше offlineGraceMs — эфир закрыт, итог ушёл отдельным сообщением', async () => {
    harness.cleanup();
    harness = createHarness({
      twitch: { login: 'me', clientId: 'id', clientSecret: 'secret' },
      vkvideo: { channel: 'me' },
      vkVideoReplayUrl: 'https://vkvideo.ru/@me',
    });
    harness.store.setAnnounceText('Врезка анонса');
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(3);

    harness.watchers.twitch.state = null;
    await run(5);

    expect(harness.store.openBroadcast()).toBeNull();
    expect(harness.telegram.editMessageCaption).not.toHaveBeenCalled();
    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(1);

    const text = harness.telegram.sendMessage.mock.calls[0]?.[0] ?? '';
    expect(text).not.toContain('Всем привет');
    expect(text).not.toContain('Врезка анонса');
    // Последний live-сигнал на 3-й минуте, первый — на 1-й.
    expect(text).toContain('Эфир завершён, длился 2 мин');
    expect(text).toContain('<a href="https://twitch.tv/me">Twitch</a>');
    expect(text).toContain('<a href="https://vkvideo.ru/@me">VK Video</a>');
    expect(text).toContain('<a href="https://live.vkvideo.ru/me">VK Live</a>');
    expect(text).not.toContain('YouTube');
  });

  it('эфир без анонса — итог не отправляется', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(1);

    harness.watchers.twitch.state = null;
    await run(5);

    expect(harness.store.openBroadcast()).toBeNull();
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
    expect(harness.telegram.sendPhoto).not.toHaveBeenCalled();
  });

  it('ошибка проверки не закрывает эфир', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(3);

    harness.watchers.twitch.state = new Error('ECONNRESET');
    await run(10);

    expect(harness.store.openBroadcast()).not.toBeNull();
    expect(harness.telegram.editMessageCaption).not.toHaveBeenCalled();
  });

  it('упавшая площадка не мешает остальным попасть в анонс', async () => {
    harness.watchers.twitch.state = new Error('503');
    harness.watchers.youtube.state = liveStream('youtube', harness.clock);

    await run(3);

    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.telegram.sendMessage.mock.calls[0]?.[0]).toContain('YouTube');
  });

  it('с VKVIDEO_REPLAY_URL в анонсе две ссылки VK: Video и Live', async () => {
    harness.cleanup();
    harness = createHarness({ vkVideoReplayUrl: 'https://vkvideo.ru/@me' });
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    harness.watchers.vkvideo.state = liveStream('vkvideo', harness.clock);

    await run(3);

    const linkLines = caption().split('\n').filter((line) => line.startsWith('▶️'));
    expect(linkLines).toEqual([
      '▶️ <a href="https://twitch.tv/me">Twitch</a>',
      '▶️ <a href="https://vkvideo.ru/@me">VK Video</a>',
      '▶️ <a href="https://live.vkvideo.ru/me">VK Live</a>',
    ]);
  });

  it('рестарт посреди эфира не порождает второй анонс', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(3);
    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);

    const restarted = harness.restart();
    harness.clock.advance(MINUTE);
    await restarted.tick();

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('врезка из /text попадает в анонс и гаснет после отправки', async () => {
    harness.store.setAnnounceText('Сегодня добиваем сюжетку');
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    await run(3);

    expect(caption()).toContain('Сегодня добиваем сюжетку');
    expect(harness.store.announceText()).toBeNull();
  });

  it('заголовок и превью берутся только с Twitch', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock, { title: 'Заголовок Twitch' });
    harness.watchers.youtube.state = liveStream('youtube', harness.clock, { title: 'Заголовок YouTube' });

    await run(3);

    expect(harness.telegram.sendPhoto.mock.calls[0]?.[0]).toBe('https://cdn/twitch.jpg');
    expect(caption()).toContain('Заголовок Twitch');
  });

  it('без Twitch заголовок и превью с других площадок не берутся', async () => {
    harness.watchers.youtube.state = liveStream('youtube', harness.clock, { title: 'Заголовок YouTube' });

    await run(3);

    expect(harness.telegram.sendPhoto).not.toHaveBeenCalled();
    const text = harness.telegram.sendMessage.mock.calls[0]?.[0] ?? '';
    expect(text).toContain('YouTube');
    expect(text).not.toContain('Заголовок YouTube');
  });

  it('своё превью из лички заменяет превью Twitch и остаётся для следующих эфиров', async () => {
    harness.store.setAnnouncePhoto('photo-file-id');
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    await run(3);

    expect(harness.telegram.sendPhoto.mock.calls[0]?.[0]).toBe('photo-file-id');
    expect(harness.store.announcePhoto()).toBe('photo-file-id');
  });

  it('своё превью уходит, даже если Twitch не в эфире', async () => {
    harness.store.setAnnouncePhoto('photo-file-id');
    harness.watchers.youtube.state = liveStream('youtube', harness.clock);

    await run(3);

    expect(harness.telegram.sendPhoto.mock.calls[0]?.[0]).toBe('photo-file-id');
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('в DRY_RUN ничего не отправляет, но состояние ведёт', async () => {
    harness.cleanup();
    harness = createHarness({ dryRun: true });
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    await run(3);

    expect(harness.telegram.sendPhoto).not.toHaveBeenCalled();
    expect(harness.store.openBroadcast()?.announcedAt).not.toBeNull();
  });

  it('onEvent: сообщает об анонсе и об окончании эфира с длительностью', async () => {
    const events: AnnouncerEvent[] = [];
    harness.cleanup();
    harness = createHarness({}, (event) => events.push(event));
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(3);
    expect(events).toEqual([{ type: 'announced', platforms: ['Twitch'] }]);

    harness.watchers.twitch.state = null;
    await run(5);

    expect(events).toEqual([
      { type: 'announced', platforms: ['Twitch'] },
      { type: 'finished', durationMs: 2 * MINUTE },
    ]);
  });

  it('onEvent: сбой отправки анонса — announce_failed, а ошибка подписчика проверку не ломает', async () => {
    const events: AnnouncerEvent[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.cleanup();
    harness = createHarness({}, (event) => {
      events.push(event);
      throw new Error('boom');
    });
    harness.telegram.sendPhoto.mockRejectedValue(new TelegramError('upstream', 'Telegram недоступен'));
    harness.telegram.sendMessage.mockRejectedValue(new TelegramError('upstream', 'Telegram недоступен'));
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    await expect(run(3)).resolves.toBeUndefined();

    expect(events[0]).toEqual({ type: 'announce_failed', channel: 'Telegram', error: 'Telegram недоступен' });
    expect(harness.store.openBroadcast()?.announcedAt).toBeNull();
  });
});

describe('Announcer: Telegram и Discord', () => {
  const hookError = () => new DiscordError('not_found', 'вебхук не найден');
  const hookDown = () => new DiscordError('upstream', 'Discord недоступен');

  function embed(call = 0) {
    return harness.discord.send.mock.calls[call]?.[0].embeds?.[0];
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    harness.cleanup();
    harness = createHarness({}, undefined, { discord: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
      headers: { 'content-type': 'image/jpeg' },
    });
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
  });

  it('обе площадки получают анонс, в Discord — описание Markdown и превью Twitch', async () => {
    await run(3);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(embed()?.description).toContain('▶️ [Twitch](https://twitch.tv/me)');
    expect(embed()?.image).toEqual({ url: 'attachment://preview.jpg' });
    expect(harness.discord.send.mock.calls[0]?.[1]).toMatchObject({ name: 'preview.jpg', type: 'image/jpeg' });
    expect(harness.store.openBroadcast()?.announcedAt).not.toBeNull();
    expect(harness.announcer.status()?.deliveries).toEqual([
      { channel: 'telegram', label: 'Telegram', state: 'sent' },
      { channel: 'discord', label: 'Discord', state: 'sent' },
    ]);
  });

  it('своя картинка с диска уходит в Discord файлом, Telegram за ней не обращается', async () => {
    harness.image.set('AgACfileId', { data: new Uint8Array([9, 8, 7]), type: 'image/png' });
    await run(3);

    expect(harness.telegram.sendPhoto.mock.calls[0]?.[0]).toBe('AgACfileId');
    expect(harness.telegram.downloadFile).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(embed()?.image).toEqual({ url: 'attachment://announce.png' });
    expect(harness.discord.send.mock.calls[0]?.[1]).toEqual({
      name: 'announce.png',
      type: 'image/png',
      data: new Uint8Array([9, 8, 7]),
    });
  });

  it('копии на диске нет — картинка один раз докачивается из Telegram', async () => {
    harness.store.setAnnouncePhoto('old-file-id');
    await run(3);

    expect(harness.telegram.downloadFile).toHaveBeenCalledTimes(1);
    expect(harness.discord.send.mock.calls[0]?.[1]).toMatchObject({ name: 'announce.jpg', type: 'image/jpeg' });
    expect(harness.image.read()).not.toBeNull();
  });

  it('копию не удалось получить — анонс без картинки, превью Twitch не подставляется, доставка засчитана', async () => {
    harness.store.setAnnouncePhoto('old-file-id');
    harness.telegram.downloadFile.mockRejectedValue(new Error('нет сети'));
    await run(3);

    expect(embed()).not.toHaveProperty('image');
    expect(harness.discord.send.mock.calls[0]?.[1]).toBeUndefined();
    expect(axios.get).not.toHaveBeenCalled();
    expect(harness.announcer.status()?.deliveries.map((item) => item.state)).toEqual(['sent', 'sent']);
  });

  it('сбой загрузки превью Twitch — анонс без картинки, доставка засчитана', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('timeout'));
    await run(3);

    expect(embed()).not.toHaveProperty('image');
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(harness.announcer.status()?.deliveries.map((item) => item.state)).toEqual(['sent', 'sent']);
  });

  it('ответ превью не картинка — анонс без картинки', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: new TextEncoder().encode('<html>').buffer,
      headers: { 'content-type': 'text/html' },
    });
    await run(3);

    expect(embed()).not.toHaveProperty('image');
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
  });

  it.each(['youtube', 'vkvideo'] as const)('приоритетная площадка %s — Discord получает анонс текстом', async (platform) => {
    harness.cleanup();
    harness = createHarness({ primaryPlatform: platform }, undefined, { discord: true });
    harness.watchers[platform].state = liveStream(platform, harness.clock);
    await run(3);

    expect(embed()).not.toHaveProperty('image');
    expect(axios.get).not.toHaveBeenCalled();
    expect(harness.discord.send.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('нет превью — Discord получает сообщение без картинки', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock, { thumbnailUrl: undefined });
    await run(3);

    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(embed()).not.toHaveProperty('image');
  });

  it('врезка из /text попадает в обе площадки (в Discord — Markdown)', async () => {
    harness.store.setAnnounceText('Сегодня *финал*');
    await run(3);

    expect(harness.telegram.sendPhoto.mock.calls[0]?.[1]).toContain('Сегодня *финал*');
    expect(embed()?.description).toContain('Сегодня \\*финал\\*');
    expect(harness.store.announceText()).toBeNull();
  });

  it('сбой Discord не мешает Telegram, а Discord повторяется в следующем тике', async () => {
    harness.discord.send.mockRejectedValueOnce(hookDown());
    await run(3);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(harness.announcer.status()?.deliveries.map((item) => item.state)).toEqual(['sent', 'pending']);

    await run(1);

    expect(harness.discord.send).toHaveBeenCalledTimes(2);
    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);

    await run(2);
    expect(harness.discord.send).toHaveBeenCalledTimes(2);
  });

  it('повтор для Discord использует зафиксированную врезку, а не новую /text', async () => {
    harness.store.setAnnounceText('Старая врезка');
    harness.discord.send.mockRejectedValueOnce(hookDown());
    await run(3);
    harness.store.setAnnounceText('Новая врезка');

    await run(1);

    expect(embed(1)?.description).toContain('Старая врезка');
    expect(embed(1)?.description).not.toContain('Новая врезка');
  });

  it('сбой Telegram не мешает Discord, а Telegram повторяется', async () => {
    harness.telegram.sendPhoto.mockRejectedValueOnce(new TelegramError('upstream', 'Telegram недоступен'));
    harness.telegram.sendMessage.mockRejectedValueOnce(new TelegramError('upstream', 'Telegram недоступен'));
    await run(3);

    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(harness.store.openBroadcast()?.announcedAt).not.toBeNull();

    await run(1);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(2);
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
  });

  it('постоянная ошибка Discord: повторов нет, Telegram цел, приложение не падает', async () => {
    harness.discord.send.mockRejectedValue(hookError());

    await expect(run(6)).resolves.toBeUndefined();

    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.announcer.status()?.deliveries.map((item) => item.state)).toEqual(['sent', 'failed']);
  });

  it('постоянная ошибка Telegram, как и раньше, прерывает проверку, но Discord получает анонс', async () => {
    harness.telegram.sendPhoto.mockRejectedValue(new TelegramError('unauthorized', 'неверный токен'));
    harness.telegram.sendMessage.mockRejectedValue(new TelegramError('unauthorized', 'неверный токен'));

    harness.clock.advance(MINUTE);
    await harness.announcer.tick();
    harness.clock.advance(MINUTE);
    await harness.announcer.tick();
    harness.clock.advance(MINUTE);
    await expect(harness.announcer.tick()).rejects.toMatchObject({ code: 'unauthorized' });

    expect(harness.discord.send).toHaveBeenCalledTimes(1);
  });

  it('событие сбоя называет площадку', async () => {
    const events: AnnouncerEvent[] = [];
    harness.cleanup();
    harness = createHarness({}, (event) => events.push(event), { discord: true });
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    harness.discord.send.mockRejectedValue(hookError());

    await run(3);

    expect(events).toContainEqual({ type: 'announce_failed', channel: 'Discord', error: 'вебхук не найден' });
    expect(events.filter((event) => event.type === 'announced')).toHaveLength(1);
  });

  it('рестарт посреди эфира не даёт дублей ни в одной площадке', async () => {
    await run(3);

    harness.announcer = harness.restart();
    await run(3);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
  });

  it('рестарт досылает только недоставленную площадку', async () => {
    harness.discord.send.mockRejectedValueOnce(hookDown());
    await run(3);

    harness.announcer = harness.restart();
    await run(1);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).toHaveBeenCalledTimes(2);
  });

  it('итог эфира уходит в обе площадки, где был анонс', async () => {
    await run(3);
    harness.watchers.twitch.state = null;
    await run(5);

    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).toHaveBeenCalledTimes(2);
    expect(embed(1)?.description).toContain('Эфир завершён, длился 2 мин');
  });

  it('итог уходит только туда, куда дошёл анонс', async () => {
    harness.discord.send.mockRejectedValue(hookError());
    await run(3);
    harness.discord.send.mockClear();
    harness.watchers.twitch.state = null;
    await run(5);

    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).not.toHaveBeenCalled();
  });

  it('сбой итога в одной площадке не мешает другой и не повторяется', async () => {
    await run(3);
    harness.telegram.sendMessage.mockRejectedValue(new TelegramError('upstream', 'Telegram недоступен'));
    harness.watchers.twitch.state = null;
    await run(8);

    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).toHaveBeenCalledTimes(2);
  });

  it('Discord, добавленный после анонса, анонса не получает, но итог и следующие эфиры — получает', async () => {
    harness.announcer = harness.restart(false);
    await run(3);
    expect(harness.discord.send).not.toHaveBeenCalled();

    harness.announcer = harness.restart(true);
    await run(3);
    expect(harness.discord.send).not.toHaveBeenCalled();

    harness.watchers.twitch.state = null;
    await run(5);
    expect(harness.discord.send).not.toHaveBeenCalled(); // итог — только туда, куда дошёл анонс

    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(3);
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
  });

  it('без вебхука всё как раньше: ни одного вызова Discord', async () => {
    harness.announcer = harness.restart(false);
    await run(3);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).not.toHaveBeenCalled();
    expect(harness.announcer.status()?.deliveries).toEqual([{ channel: 'telegram', label: 'Telegram', state: 'sent' }]);
  });

  it('DRY_RUN действует на все площадки', async () => {
    harness.cleanup();
    harness = createHarness({ dryRun: true }, undefined, { discord: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    await run(3);
    harness.watchers.twitch.state = null;
    await run(5);

    expect(harness.telegram.sendPhoto).not.toHaveBeenCalled();
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
    expect(harness.discord.send).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(harness.store.openBroadcast()).toBeNull();
  });

  it('DRY_RUN не качает ни превью, ни свою картинку', async () => {
    harness.cleanup();
    harness = createHarness({ dryRun: true }, undefined, { discord: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    harness.store.setAnnouncePhoto('old-file-id');
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    await run(3);

    expect(harness.telegram.downloadFile).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('Announcer: тестовый анонс', () => {
  const MARKER = '🧪 Тест';

  beforeEach(() => {
    harness.cleanup();
    harness = createHarness({}, undefined, { discord: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
      headers: { 'content-type': 'image/jpeg' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('уходит только в выбранную площадку, с пометкой; Telegram — тихо', async () => {
    await harness.announcer.testAnnounce('telegram');

    expect(harness.discord.send).not.toHaveBeenCalled();
    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.telegram.sendMessage.mock.calls[0]?.[0].startsWith(MARKER)).toBe(true);
    expect(harness.telegram.sendMessage.mock.calls[0]?.[1]).toEqual({ silent: true });

    await harness.announcer.testAnnounce('discord');

    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(harness.discord.send.mock.calls[0]?.[0].embeds?.[0]?.description.startsWith(MARKER)).toBe(true);
  });

  it('без эфира — примерные название и игра, ссылки на каналы', async () => {
    await harness.announcer.testAnnounce('telegram');

    const text = harness.telegram.sendMessage.mock.calls[0]?.[0] ?? '';
    expect(text).toContain('Название стрима на Twitch');
    expect(text).toContain('Игра на Twitch');
  });

  it('при живом эфире — его данные и превью, тихо', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(1);

    await harness.announcer.testAnnounce('telegram');

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.telegram.sendPhoto.mock.calls[0]?.[0]).toBe('https://cdn/twitch.jpg');
    expect(harness.telegram.sendPhoto.mock.calls[0]?.[1]).toContain('Вечерний стрим');
    expect(harness.telegram.sendPhoto.mock.calls[0]?.[1].startsWith(MARKER)).toBe(true);
    expect(harness.telegram.sendPhoto.mock.calls[0]?.[2]).toEqual({ silent: true });

    await harness.announcer.testAnnounce('discord');

    expect(harness.discord.send.mock.calls[0]?.[0].embeds?.[0]?.description).toContain('Вечерний стрим');
    expect(harness.discord.send.mock.calls[0]?.[1]).toMatchObject({ name: 'preview.jpg' });
  });

  it('учитывает врезку и свою картинку', async () => {
    harness.store.setAnnounceText('Сегодня финал');
    harness.image.set('AgACfileId', { data: new Uint8Array([9, 8, 7]), type: 'image/png' });
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(1);

    await harness.announcer.testAnnounce('telegram');
    await harness.announcer.testAnnounce('discord');

    expect(harness.telegram.sendPhoto.mock.calls[0]?.[0]).toBe('AgACfileId');
    expect(harness.telegram.sendPhoto.mock.calls[0]?.[1]).toContain('Сегодня финал');
    expect(harness.discord.send.mock.calls[0]?.[0].embeds?.[0]?.description).toContain('Сегодня финал');
    expect(harness.discord.send.mock.calls[0]?.[1]).toMatchObject({ name: 'announce.png' });
    expect(harness.store.announceText()).toBe('Сегодня финал');
  });

  it('фолбэк «фото не ушло → текстом» тоже тихий', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(1);
    harness.telegram.sendPhoto.mockRejectedValueOnce(new TelegramError('upstream', 'не подгрузилось'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await harness.announcer.testAnnounce('telegram');

    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.telegram.sendMessage.mock.calls[0]?.[0].startsWith(MARKER)).toBe(true);
    expect(harness.telegram.sendMessage.mock.calls[0]?.[1]).toEqual({ silent: true });
  });

  it('не пишет в базу, не меняет эфир и не шлёт события', async () => {
    const events: AnnouncerEvent[] = [];
    harness.cleanup();
    harness = createHarness({ dryRun: true }, (event) => events.push(event), { discord: true });
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(1);
    const before = harness.store.openBroadcast();

    await harness.announcer.testAnnounce('telegram');
    await harness.announcer.testAnnounce('discord');

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(harness.store.openBroadcast()).toEqual(before);
    expect(harness.store.deliveriesOf(before!.id)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('ошибка клиента пробрасывается', async () => {
    harness.telegram.sendMessage.mockRejectedValueOnce(new TelegramError('upstream', 'Telegram недоступен'));
    harness.discord.send.mockRejectedValueOnce(new DiscordError('upstream', 'Discord недоступен'));

    await expect(harness.announcer.testAnnounce('telegram')).rejects.toThrow('Telegram недоступен');
    await expect(harness.announcer.testAnnounce('discord')).rejects.toThrow('Discord недоступен');
  });

  it('настоящий анонс и превью без пометки и не тихие', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(3);

    expect(harness.telegram.sendPhoto.mock.calls[0]?.[1]).not.toContain('🧪');
    expect(harness.telegram.sendPhoto.mock.calls[0]?.[2]).toBeUndefined();
    expect(harness.discord.send.mock.calls[0]?.[0].embeds?.[0]?.description).not.toContain('🧪');
    expect(harness.announcer.preview().announce).not.toContain('🧪');
  });
});

describe('Announcer: только Discord', () => {
  function embed(call = 0) {
    return harness.discord.send.mock.calls[call]?.[0].embeds?.[0];
  }

  beforeEach(() => {
    harness.cleanup();
    harness = createHarness({}, undefined, { discord: true, telegram: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
      headers: { 'content-type': 'image/jpeg' },
    });
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('анонс и итог уходят только в Discord, status() без чата и сообщения Telegram', async () => {
    await run(3);

    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(embed()?.description).toContain('▶️ [Twitch](https://twitch.tv/me)');
    expect(harness.telegram.sendPhoto).not.toHaveBeenCalled();
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
    expect(harness.announcer.status()).toMatchObject({
      chatId: null,
      messageId: null,
      deliveries: [{ channel: 'discord', label: 'Discord', state: 'sent' }],
    });

    harness.watchers.twitch.state = null;
    await run(5);

    expect(harness.discord.send).toHaveBeenCalledTimes(2);
    expect(embed(1)?.description).toContain('Эфир завершён');
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('рестарт не дублирует анонс', async () => {
    await run(3);
    harness.announcer = harness.restart(true);
    await run(3);

    expect(harness.discord.send).toHaveBeenCalledTimes(1);
  });

  it('testAnnounce по Telegram, которого нет, даёт понятную ошибку', async () => {
    await expect(harness.announcer.testAnnounce('telegram')).rejects.toThrow('telegram: площадка не настроена');
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('картинка, загруженная из панели, уходит в Discord файлом', async () => {
    harness.image.setLocal({ data: new Uint8Array([1, 2, 3]), type: 'image/png' });
    await run(3);

    expect(embed()?.image).toEqual({ url: 'attachment://announce.png' });
    expect(harness.discord.send.mock.calls[0]?.[1]).toEqual({
      name: 'announce.png',
      type: 'image/png',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('старая картинка Telegram с копией на диске берётся из копии без запросов к Telegram', async () => {
    harness.image.set('AgACfileId', { data: new Uint8Array([9, 8, 7]), type: 'image/jpeg' });
    await run(3);

    expect(harness.discord.send.mock.calls[0]?.[1]).toMatchObject({ name: 'announce.jpg', data: new Uint8Array([9, 8, 7]) });
    expect(harness.telegram.downloadFile).not.toHaveBeenCalled();
  });

  it('старая картинка Telegram без копии молча пропускается: анонс с превью Twitch, Telegram не трогаем', async () => {
    harness.store.setAnnouncePhoto('old-file-id');
    await run(3);

    expect(harness.telegram.downloadFile).not.toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(harness.discord.send.mock.calls[0]?.[1]).toMatchObject({ name: 'preview.jpg' });
    expect(harness.image.has()).toBe(false);
  });
});

describe('Announcer: картинка только с локальным файлом при включённом Telegram', () => {
  beforeEach(() => {
    harness.cleanup();
    harness = createHarness({}, undefined, { discord: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Telegram отправляет файл, а не file_id, Discord получает тот же файл', async () => {
    harness.image.setLocal({ data: new Uint8Array([5, 6]), type: 'image/webp' });
    await run(3);

    expect(harness.telegram.sendPhotoFile).toHaveBeenCalledTimes(1);
    expect(harness.telegram.sendPhotoFile.mock.calls[0]?.slice(0, 2)).toEqual([new Uint8Array([5, 6]), 'image/webp']);
    expect(harness.telegram.sendPhoto).not.toHaveBeenCalled();
    expect(harness.discord.send.mock.calls[0]?.[1]).toMatchObject({ name: 'announce.webp' });
  });
});
