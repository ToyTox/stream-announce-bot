import { isPlatform, Platform } from './types.js';

/**
 * Весь env читается здесь и только здесь. loadConfig() валится с внятным текстом,
 * если чего-то не хватает: лучше упасть на старте, чем молча не отправить анонс.
 */
export interface TwitchConfig {
  login: string;
  clientId: string;
  clientSecret: string;
}

export interface YouTubeConfig {
  channelId: string;
  apiKey?: string;
}

export interface VkVideoConfig {
  channel: string;
}

export interface Config {
  telegram: {
    botToken: string;
    chatId: string;
    topicId?: number;
    adminId?: number;
  };
  twitch?: TwitchConfig;
  youtube?: YouTubeConfig;
  vkvideo?: VkVideoConfig;
  pollIntervalMs: number;
  announceGraceMs: number;
  offlineGraceMs: number;
  primaryPlatform: Platform;
  announceEnd: boolean;
  /** Канал на vkvideo.ru с записями — для итогового сообщения. */
  vkVideoReplayUrl?: string;
  dryRun: boolean;
  databasePath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: Env, name: string): string {
  const value = str(env, name);
  if (!value) {
    throw new ConfigError(`Не задана переменная ${name} — заполните .env (образец в .env.example)`);
  }
  return value;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${name} должна быть числом, получено "${raw}"`);
  }
  return value;
}

function optionalInt(env: Env, name: string): number | undefined {
  const raw = str(env, name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${name} должна быть числом, получено "${raw}"`);
  }
  return value;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = str(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Блок платформы собирается только если заданы все её параметры: бот должен
 * уметь работать с одним Twitch, если YouTube и VK Video не настроены.
 * Частично заполненный блок — это опечатка, а не выбор, поэтому ошибка.
 */
function twitchConfig(env: Env): TwitchConfig | undefined {
  const login = str(env, 'TWITCH_LOGIN');
  const clientId = str(env, 'TWITCH_CLIENT_ID');
  const clientSecret = str(env, 'TWITCH_CLIENT_SECRET');
  if (!login && !clientId && !clientSecret) return undefined;
  if (!login || !clientId || !clientSecret) {
    throw new ConfigError(
      'Для Twitch нужны TWITCH_LOGIN, TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET — заполнены не все'
    );
  }
  return { login, clientId, clientSecret };
}

function youtubeConfig(env: Env): YouTubeConfig | undefined {
  const channelId = str(env, 'YOUTUBE_CHANNEL_ID');
  if (!channelId) return undefined;
  return { channelId, apiKey: str(env, 'YOUTUBE_API_KEY') };
}

function vkVideoConfig(env: Env): VkVideoConfig | undefined {
  const channel = str(env, 'VKVIDEO_CHANNEL');
  return channel ? { channel } : undefined;
}

export function loadConfig(env: Env = process.env): Config {
  const primaryRaw = str(env, 'PRIMARY_PLATFORM') ?? 'twitch';
  if (!isPlatform(primaryRaw)) {
    throw new ConfigError(
      `PRIMARY_PLATFORM: ожидается twitch, youtube или vkvideo, получено "${primaryRaw}"`
    );
  }

  const config: Config = {
    telegram: {
      botToken: required(env, 'TELEGRAM_BOT_TOKEN'),
      chatId: required(env, 'TELEGRAM_CHAT_ID'),
      topicId: optionalInt(env, 'TELEGRAM_TOPIC_ID'),
      adminId: optionalInt(env, 'TELEGRAM_ADMIN_ID'),
    },
    twitch: twitchConfig(env),
    youtube: youtubeConfig(env),
    vkvideo: vkVideoConfig(env),
    pollIntervalMs: int(env, 'POLL_INTERVAL_MS', 60_000),
    announceGraceMs: int(env, 'ANNOUNCE_GRACE_MS', 90_000),
    offlineGraceMs: int(env, 'OFFLINE_GRACE_MS', 180_000),
    primaryPlatform: primaryRaw,
    announceEnd: bool(env, 'ANNOUNCE_END', true),
    vkVideoReplayUrl: str(env, 'VKVIDEO_REPLAY_URL'),
    dryRun: bool(env, 'DRY_RUN', false),
    databasePath: str(env, 'DATABASE_PATH') ?? './data/bot.db',
  };

  if (!config.twitch && !config.youtube && !config.vkvideo) {
    throw new ConfigError(
      'Не настроена ни одна платформа: задайте TWITCH_*, YOUTUBE_CHANNEL_ID или VKVIDEO_CHANNEL'
    );
  }

  return config;
}
