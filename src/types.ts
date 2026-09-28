/** Платформы, за которыми умеет следить бот. Порядок важен: по нему выбирается запасная площадка для заголовка и превью. */
export const PLATFORMS = ['twitch', 'youtube', 'vkvideo'] as const;

export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  vkvideo: 'VK Video',
};

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** Живая трансляция на одной платформе. */
export interface LiveStream {
  platform: Platform;
  externalId: string;
  title: string;
  game?: string;
  url: string;
  thumbnailUrl?: string;
  startedAt: Date;
  viewers?: number;
}
