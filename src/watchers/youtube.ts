import axios from 'axios';
import type { YouTubeConfig } from '../config.js';
import { LiveStream, Platform } from '../types.js';
import { BaseWatcher, httpConfig } from './base.js';

const API_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

/**
 * Без ключа читаем страницу /live и достаём ytInitialPlayerResponse: search.list
 * в Data API стоит 100 единиц квоты при лимите 10 000/день, на опрос раз в минуту
 * этого не хватает. Разметка YouTube меняется — поэтому при заданном YOUTUBE_API_KEY
 * используется официальный API.
 */
export class YouTubeWatcher extends BaseWatcher {
  readonly platform: Platform = 'youtube';

  constructor(private readonly config: YouTubeConfig) {
    super();
  }

  async fetchLive(): Promise<LiveStream | null> {
    return this.config.apiKey ? this.fetchViaApi(this.config.apiKey) : this.fetchViaPage();
  }

  private async fetchViaPage(): Promise<LiveStream | null> {
    const response = await axios.get<string>(
      `https://www.youtube.com/channel/${this.config.channelId}/live`,
      { ...httpConfig, responseType: 'text' }
    );

    const parsed = parsePlayerResponse(response.data);
    if (!parsed) return null;

    return {
      platform: 'youtube',
      externalId: parsed.videoId,
      title: parsed.title,
      game: undefined,
      url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${parsed.videoId}/maxresdefault.jpg`,
      startedAt: parsed.startedAt ?? new Date(),
    };
  }

  private async fetchViaApi(apiKey: string): Promise<LiveStream | null> {
    const response = await axios.get<{
      items?: Array<{
        id?: { videoId?: string };
        snippet?: { title?: string; publishedAt?: string };
      }>;
    }>(API_SEARCH_URL, {
      ...httpConfig,
      params: {
        part: 'snippet',
        channelId: this.config.channelId,
        eventType: 'live',
        type: 'video',
        maxResults: 1,
        key: apiKey,
      },
    });

    const item = response.data.items?.[0];
    const videoId = item?.id?.videoId;
    if (!videoId) return null;

    return {
      platform: 'youtube',
      externalId: videoId,
      title: item?.snippet?.title ?? 'Трансляция',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      startedAt: item?.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : new Date(),
    };
  }
}

export interface ParsedYouTubeLive {
  videoId: string;
  title: string;
  startedAt?: Date;
}

/**
 * Разбор страницы канала. Возвращает null и для «нет эфира», и для незнакомой
 * разметки: отличить одно от другого по HTML нельзя, а падать на каждом редизайне
 * YouTube не хочется — эфир от этого всё равно не закроется раньше времени.
 */
export function parsePlayerResponse(html: string): ParsedYouTubeLive | null {
  const isLive = /"isLive"\s*:\s*true/.test(html);
  if (!isLive) return null;

  const videoId = matchFirst(html, /"videoId"\s*:\s*"([\w-]{11})"/);
  if (!videoId) return null;

  // Заголовок берём из videoDetails, а не из og:title — тот содержит имя канала.
  const title =
    matchFirst(html, /"videoDetails"\s*:\s*\{[^}]*?"title"\s*:\s*"((?:[^"\\]|\\.)*)"/) ??
    matchFirst(html, /<meta\s+name="title"\s+content="([^"]*)"/) ??
    'Трансляция';

  const startTimestamp = matchFirst(html, /"startTimestamp"\s*:\s*"([^"]+)"/);
  const startedAt = startTimestamp ? new Date(startTimestamp) : undefined;

  return {
    videoId,
    title: decodeJsonString(title),
    startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : undefined,
  };
}

function matchFirst(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1];
}

/** В HTML заголовок лежит внутри JSON-строки: &, \" и прочее. */
function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}
