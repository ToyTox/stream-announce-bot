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

export interface DiscordConfig {
  webhookUrl: string;
}

export interface Config {
  telegram: {
    botToken: string;
    chatId: string;
    topicId?: number;
    adminId?: number;
  };
  /** Необязательная вторая площадка доставки: анонсы дублируются в канал Discord. */
  discord?: DiscordConfig;
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

export type Env = Record<string, string | undefined>;

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

const DISCORD_HOSTS = new Set([
  'discord.com',
  'ptb.discord.com',
  'canary.discord.com',
  'discordapp.com',
  'ptb.discordapp.com',
  'canary.discordapp.com',
]);

/**
 * Вебхук Discord: https://discord.com/api/webhooks/{id}/{token}. В адресе лежит токен,
 * поэтому в тексте ошибки значение не повторяем.
 */
function discordConfig(env: Env): DiscordConfig | undefined {
  const raw = str(env, 'DISCORD_WEBHOOK_URL');
  if (!raw) return undefined;

  const fail = (): never => {
    throw new ConfigError(
      'DISCORD_WEBHOOK_URL: ожидается адрес вебхука вида https://discord.com/api/webhooks/<id>/<токен> без параметров'
    );
  };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  const validPath = /^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname);
  const clean = !url.search && !url.hash && !url.username && !url.password && !url.port;
  if (url.protocol !== 'https:' || !DISCORD_HOSTS.has(url.hostname) || !validPath || !clean) return fail();

  return { webhookUrl: `${url.origin}${url.pathname.replace(/\/$/, '')}` };
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
    discord: discordConfig(env),
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

export interface WebConfig {
  enabled: boolean;
  port: number;
}

/**
 * Панель настраивается отдельно от бота: она должна подняться, даже если остальной
 * конфиг невалиден — как раз чтобы его исправить.
 */
export function loadWebConfig(env: Env = process.env): WebConfig {
  const port = int(env, 'WEB_PORT', 3210);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`WEB_PORT должен быть от 1 до 65535, получено ${port}`);
  }
  return { enabled: bool(env, 'WEB_ENABLED', true), port };
}
