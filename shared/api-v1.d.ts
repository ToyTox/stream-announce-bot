/** Контракт /api/v1 описан в docs/api-v1.yaml. */

export type UnixMillis = number;
export type Platform = 'twitch' | 'youtube' | 'vkvideo';
export type DeliveryChannel = 'telegram' | 'discord';
export type DeliveryState = 'pending' | 'sent' | 'failed';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Сервер игнорирует тело POST /probe, /test-message и /test-announce/*. */
export type IgnoredJsonBody = JsonValue | undefined;

export interface ErrorResponse {
  error: string;
}

export interface OkResponse {
  ok: true;
}

export interface InfoResponse {
  apiVersion: 1;
  version: string;
}

export interface StoppedStatus {
  version: string;
  running: false;
  configError: string | null;
}

export interface RunningStatus {
  version: string;
  running: true;
  configError: null;
  dryRun: boolean;
  telegramSet: boolean;
  adminSet: boolean;
  discordSet: boolean;
  broadcast: Broadcast | null;
  platforms: PlatformStatus[];
  text: string | null;
  hasImage: boolean;
}

/** Ответ GET /status и POST /probe. */
export type StatusResponse = StoppedStatus | RunningStatus;

export interface Broadcast {
  startedAt: UnixMillis;
  announcedAt: UnixMillis | null;
  chatId: string | null;
  messageId: number | null;
  messageUrl: string | null;
  platforms: Platform[];
  deliveries: Array<{ channel: DeliveryChannel; label: string; state: DeliveryState }>;
}

export interface PlatformStatus {
  platform: Platform;
  label: string;
  url: string;
  state: 'pending' | 'live' | 'offline' | 'error';
  checkedAt: UnixMillis | null;
  error?: string;
}

export interface LogsQuery {
  /** Ответ содержит строки с seq строго больше этого значения. */
  after?: number;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  /** Сквозной номер строки в рамках одного запуска процесса. */
  seq: number;
  time: UnixMillis;
  level: LogLevel;
  text: string;
}

export interface LogsResponse {
  lines: LogLine[];
}

export interface PreviewResponse {
  announce: string;
  finished: string;
  photo: 'custom' | 'twitch';
}

export interface PairingRequest {
  code: string;
  name: string;
}

export interface PairingResult {
  device: {
    id: number;
    name: string;
    createdAt: UnixMillis;
    lastUsedAt: null;
    revokedAt: null;
  };
  token: string;
}

export type TestMessageTarget =
  | { channel: 'telegram'; label: 'Telegram' }
  | { channel: 'discord'; label: 'Discord' };

type SuccessfulTestDelivery = TestMessageTarget & { ok: true; error?: never };
type FailedTestDelivery = TestMessageTarget & { ok: false; error: string };

export type TestMessageDelivery = SuccessfulTestDelivery | FailedTestDelivery;

export type TestMessageResult =
  | { ok: true; results: [] | [SuccessfulTestDelivery] | [SuccessfulTestDelivery, SuccessfulTestDelivery] }
  | { ok: false; results: [FailedTestDelivery] | [FailedTestDelivery, TestMessageDelivery] | [SuccessfulTestDelivery, FailedTestDelivery] };

export interface TextWriteRequest {
  /** Пустая строка, пропуск и любое нестроковое значение сбрасывают врезку. */
  text?: JsonValue;
}

export type TextWriteBody = TextWriteRequest | JsonPrimitive | JsonValue[] | undefined;

export interface TextResponse {
  text: string | null;
}

export interface TextDeleteResponse {
  text: null;
}

export interface LinkInput {
  label: string;
  url: string;
  always?: boolean;
}

export interface Link extends LinkInput {
  always: boolean;
}

export interface LinksWriteRequest {
  links: LinkInput[];
}

export interface LinksResponse {
  links: Link[];
}

export type SecretSettingKey = 'TELEGRAM_BOT_TOKEN' | 'DISCORD_WEBHOOK_URL' | 'TWITCH_CLIENT_SECRET' | 'YOUTUBE_API_KEY';

/** Ключи полей, которые сервер возвращает с открытым значением. */
export type PublicSettingKey =
  | 'TELEGRAM_CHAT_ID'
  | 'TELEGRAM_TOPIC_ID'
  | 'TELEGRAM_ADMIN_ID'
  | 'TWITCH_LOGIN'
  | 'TWITCH_CLIENT_ID'
  | 'YOUTUBE_CHANNEL_ID'
  | 'VKVIDEO_CHANNEL'
  | 'VKVIDEO_REPLAY_URL'
  | 'APP_LANGUAGE'
  | 'ANNOUNCE_LANGUAGE'
  | 'PRIMARY_PLATFORM'
  | 'POLL_INTERVAL_MS'
  | 'ANNOUNCE_GRACE_MS'
  | 'OFFLINE_GRACE_MS'
  | 'ANNOUNCE_END'
  | 'DRY_RUN';

export type SettingFieldType = 'text' | 'number' | 'bool' | 'select';

interface SettingFieldInfo {
  group: string;
  label: string;
  type: SettingFieldType;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  isSet: boolean;
}

export interface PublicSettingFieldView extends SettingFieldInfo {
  key: PublicSettingKey;
  secret?: never;
  value: string;
}

export interface SecretSettingFieldView extends SettingFieldInfo {
  key: SecretSettingKey;
  secret: true;
  value?: never;
}

export type SettingFieldView = PublicSettingFieldView | SecretSettingFieldView;

export interface SettingsResponse {
  fields: SettingFieldView[];
  configError: string | null;
}

type SettingsValues = {
  [key: string]: JsonValue;
} & {
  [Key in SecretSettingKey]?: never;
};

export interface SettingsWriteRequest {
  /** Записываются только известные несекретные ключи со строковыми или логическими значениями. */
  values?: SettingsValues | JsonPrimitive | JsonValue[];
}

export type SettingsWriteBody = SettingsWriteRequest | JsonPrimitive | JsonValue[] | undefined;

export type SettingsWriteResult =
  | { ok: true; changed: []; configError?: never }
  | { ok: true; changed: [string, ...string[]]; configError: string | null };

export type ImageContentType = 'image/jpeg' | 'image/png' | 'image/webp';

/** Сырые байты и Content-Type для PUT /image и GET /image/file. */
export interface ImageFile<ContentType extends string = ImageContentType> {
  type: ContentType;
  data: Uint8Array;
}
