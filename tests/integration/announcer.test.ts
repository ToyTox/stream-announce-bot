import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function lastEdit(): string {
  const calls = harness.telegram.editMessageCaption.mock.calls;
  return calls[calls.length - 1]?.[1] ?? '';
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

  it('платформа подключилась после анонса — сообщение отредактировано, второго нет', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    await run(3);
    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);

    harness.watchers.vkvideo.state = liveStream('vkvideo', harness.clock);
    await run(2);

    expect(harness.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
    expect(harness.telegram.editMessageCaption).toHaveBeenCalled();
    expect(lastEdit()).toContain('Twitch');
    expect(lastEdit()).toContain('VK Live');
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

  it('Twitch подключился после анонса — заголовок дописывается правкой', async () => {
    harness.watchers.youtube.state = liveStream('youtube', harness.clock, { title: 'Заголовок YouTube' });
    await run(3);

    harness.watchers.twitch.state = liveStream('twitch', harness.clock, { title: 'Заголовок Twitch' });
    await run(1);

    expect(lastEdit()).toContain('Заголовок Twitch');
  });

  it('заголовок Twitch не пропадает, пока Twitch моргает', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock, { title: 'Заголовок Twitch' });
    harness.watchers.youtube.state = liveStream('youtube', harness.clock, { title: 'Заголовок YouTube' });
    await run(3);

    harness.watchers.twitch.state = null;
    await run(1);

    expect(lastEdit()).toContain('Заголовок Twitch');
    expect(lastEdit()).not.toContain('>Twitch<');
  });

  it('в DRY_RUN ничего не отправляет, но состояние ведёт', async () => {
    harness.cleanup();
    harness = createHarness({ dryRun: true });
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    await run(3);

    expect(harness.telegram.sendPhoto).not.toHaveBeenCalled();
    expect(harness.store.openBroadcast()?.announcedAt).not.toBeNull();
  });
});
