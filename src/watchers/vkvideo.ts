import axios from 'axios';
import type { VkVideoConfig } from '../config.js';
import { LiveStream, Platform } from '../types.js';
import { BaseWatcher, httpConfig } from './base.js';

/** live.vkplay.ru переехал на live.vkvideo.ru — API и канал те же, хост вынесен в константу. */
const API_BASE = 'https://api.live.vkvideo.ru/v1';
const CHANNEL_BASE = 'https://live.vkvideo.ru';

interface StreamResponse {
  data?: {
    isOnline?: boolean;
    title?: string;
    category?: { title?: string } | null;
    previewUrl?: string | null;
    startTime?: number;
    count?: { views?: number };
    stream?: {
      id?: string | number;
      isOnline?: boolean;
      title?: string;
      startTime?: number;
      previewUrl?: string | null;
      count?: { views?: number };
    } | null;
  };
}

export class VkVideoWatcher extends BaseWatcher {
  readonly platform: Platform = 'vkvideo';

  constructor(private readonly config: VkVideoConfig) {
    super();
  }

  async fetchLive(): Promise<LiveStream | null> {
    const response = await axios.get<StreamResponse>(
      `${API_BASE}/blog/${encodeURIComponent(this.config.channel)}/public_video_stream`,
      httpConfig
    );

    const data = response.data?.data;
    if (!data) return null;

    // Поля лежат то в корне, то во вложенном stream — зависит от версии ответа.
    const stream = data.stream ?? undefined;
    const isOnline = data.isOnline ?? stream?.isOnline ?? false;
    if (!isOnline) return null;

    const startTime = data.startTime ?? stream?.startTime;
    const startedAt = startTime ? new Date(startTime * 1000) : new Date();
    const title = data.title ?? stream?.title ?? 'Трансляция';
    // Устойчивого id у трансляции нет — привязываемся к моменту старта.
    const externalId = String(stream?.id ?? startTime ?? startedAt.getTime());

    return {
      platform: 'vkvideo',
      externalId,
      title,
      game: data.category?.title || undefined,
      url: `${CHANNEL_BASE}/${this.config.channel}`,
      thumbnailUrl: data.previewUrl ?? stream?.previewUrl ?? undefined,
      startedAt,
      viewers: data.count?.views ?? stream?.count?.views,
    };
  }
}
