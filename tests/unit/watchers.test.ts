import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitchWatcher, thumbnailUrl } from '../../src/watchers/twitch.js';
import { VkVideoWatcher } from '../../src/watchers/vkvideo.js';
import { YouTubeWatcher, parsePlayerResponse } from '../../src/watchers/youtube.js';
import { readFixture, readJsonFixture } from '../helpers/fixtures.js';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
  },
}));

const mockedAxios = vi.mocked(axios, true);

const twitchConfig = { login: 'mychannel', clientId: 'cid', clientSecret: 'secret' };

beforeEach(() => {
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
});

describe('TwitchWatcher', () => {
  beforeEach(() => {
    mockedAxios.post.mockResolvedValue({ data: { access_token: 'token', expires_in: 3600 } });
  });

  it('разбирает живой стрим', async () => {
    mockedAxios.get.mockResolvedValue({ data: readJsonFixture('twitch-live.json') });

    const stream = await new TwitchWatcher(twitchConfig).fetchLive();

    expect(stream).toMatchObject({
      platform: 'twitch',
      externalId: '40527228461',
      title: 'Каток & сюжетка',
      game: 'Elden Ring',
      url: 'https://twitch.tv/mychannel',
      viewers: 142,
    });
    expect(stream?.startedAt.toISOString()).toBe('2026-09-28T18:00:00.000Z');
  });

  it('возвращает null, когда стримов нет', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } });

    expect(await new TwitchWatcher(twitchConfig).fetchLive()).toBeNull();
  });

  it('переиспользует токен между проверками', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } });
    const watcher = new TwitchWatcher(twitchConfig);

    await watcher.fetchLive();
    await watcher.fetchLive();

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('пробрасывает сетевую ошибку, а не считает площадку офлайн', async () => {
    mockedAxios.get.mockRejectedValue(new Error('ECONNRESET'));

    await expect(new TwitchWatcher(twitchConfig).fetchLive()).rejects.toThrow('ECONNRESET');
  });
});

describe('thumbnailUrl', () => {
  it('подставляет размер и cache-buster', () => {
    const url = thumbnailUrl(
      'https://cdn/live_user-{width}x{height}.jpg',
      new Date('2026-09-28T18:00:00Z')
    );

    expect(url).toBe(`https://cdn/live_user-1280x720.jpg?t=${Date.parse('2026-09-28T18:00:00Z')}`);
  });

  it('не падает без превью', () => {
    expect(thumbnailUrl(undefined, new Date())).toBeUndefined();
  });
});

describe('YouTubeWatcher', () => {
  it('находит эфир на странице канала', async () => {
    mockedAxios.get.mockResolvedValue({ data: readFixture('youtube-live.html') });

    const stream = await new YouTubeWatcher({ channelId: 'UCtest0000000000000000' }).fetchLive();

    expect(stream).toMatchObject({
      platform: 'youtube',
      externalId: 'dQw4w9WgXcQ',
      title: 'Кооп & болталка',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    });
  });

  it('возвращает null, когда эфира нет', async () => {
    mockedAxios.get.mockResolvedValue({ data: readFixture('youtube-offline.html') });

    expect(await new YouTubeWatcher({ channelId: 'UCtest' }).fetchLive()).toBeNull();
  });

  it('незнакомую разметку считает отсутствием эфира, а не ошибкой', () => {
    expect(parsePlayerResponse('<html><body>редизайн</body></html>')).toBeNull();
  });

  it('с ключом ходит в Data API', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        items: [
          {
            id: { videoId: 'abcdefghijk' },
            snippet: { title: 'Стрим', publishedAt: '2026-09-28T18:00:00Z' },
          },
        ],
      },
    });

    const stream = await new YouTubeWatcher({ channelId: 'UCtest', apiKey: 'key' }).fetchLive();

    expect(mockedAxios.get.mock.calls[0]?.[0]).toContain('googleapis.com');
    expect(stream?.externalId).toBe('abcdefghijk');
  });
});

describe('VkVideoWatcher', () => {
  it('разбирает живой стрим', async () => {
    mockedAxios.get.mockResolvedValue({ data: readJsonFixture('vkvideo-live.json') });

    const stream = await new VkVideoWatcher({ channel: 'mychannel' }).fetchLive();

    expect(stream).toMatchObject({
      platform: 'vkvideo',
      externalId: '998877',
      title: 'Вечерний кооп',
      game: 'It Takes Two',
      url: 'https://live.vkvideo.ru/mychannel',
      thumbnailUrl: 'https://images.vkplay.ru/preview/mychannel.jpg',
      viewers: 87,
    });
    expect(stream?.startedAt.getTime()).toBe(1790000000 * 1000);
  });

  it('возвращает null, когда канал офлайн', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: { isOnline: false } } });

    expect(await new VkVideoWatcher({ channel: 'mychannel' }).fetchLive()).toBeNull();
  });
});
