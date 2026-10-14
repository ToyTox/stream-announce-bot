import type { Env } from '../config.js';
import { DEFAULT_LANGUAGE, languageOptions, t, type Lang } from '../i18n/index.js';

/**
 * Описание полей формы настроек. Панель рисует форму по этому списку,
 * так что новая настройка добавляется одной строкой здесь и ключами в словарях:
 * подпись — setting.<KEY>.label, подсказка (если hint) — setting.<KEY>.hint.
 */

export type FieldType = 'text' | 'number' | 'bool' | 'select';

export interface SettingField {
  key: string;
  /** Идентификатор группы; подпись — settings.group.<group>. */
  group: string;
  type: FieldType;
  /** Есть ли подсказка в словаре. */
  hint?: boolean;
  /** Значение не отдаётся в браузер целиком; пустое поле при сохранении — «не менять». */
  secret?: boolean;
  /** label — готовая подпись (названия площадок), labelKey — ключ словаря. */
  options?: Array<{ value: string; label?: string; labelKey?: string }>;
  /** Значение по умолчанию из loadConfig — чтобы форма показывала, что реально действует. */
  placeholder?: string;
}

/** Пустое значение — «авто» (язык системы) или «как у интерфейса», дальше — по языку из каждого словаря. */
function languageChoices(emptyLabelKey: string): NonNullable<SettingField['options']> {
  return [{ value: '', labelKey: emptyLabelKey }, ...languageOptions().map(({ code, name }) => ({ value: code, label: name }))];
}

export const SETTING_FIELDS: SettingField[] = [
  { key: 'TELEGRAM_BOT_TOKEN', group: 'telegram', type: 'text', secret: true, hint: true },
  { key: 'TELEGRAM_CHAT_ID', group: 'telegram', type: 'text', hint: true },
  { key: 'TELEGRAM_TOPIC_ID', group: 'telegram', type: 'number', hint: true },
  { key: 'TELEGRAM_ADMIN_ID', group: 'telegram', type: 'number', hint: true },

  { key: 'DISCORD_WEBHOOK_URL', group: 'discord', type: 'text', secret: true, hint: true },

  { key: 'TWITCH_LOGIN', group: 'twitch', type: 'text', hint: true },
  { key: 'TWITCH_CLIENT_ID', group: 'twitch', type: 'text', hint: true },
  { key: 'TWITCH_CLIENT_SECRET', group: 'twitch', type: 'text', secret: true },

  { key: 'YOUTUBE_CHANNEL_ID', group: 'youtube', type: 'text', hint: true },
  { key: 'YOUTUBE_API_KEY', group: 'youtube', type: 'text', secret: true, hint: true },

  { key: 'VKVIDEO_CHANNEL', group: 'vk', type: 'text', hint: true },
  { key: 'VKVIDEO_REPLAY_URL', group: 'vk', type: 'text', hint: true },

  { key: 'APP_LANGUAGE', group: 'behavior', type: 'select', hint: true, options: languageChoices('settings.language.auto') },
  { key: 'ANNOUNCE_LANGUAGE', group: 'behavior', type: 'select', hint: true, options: languageChoices('settings.language.sameAsUi') },
  {
    key: 'PRIMARY_PLATFORM',
    group: 'behavior',
    type: 'select',
    options: [
      { value: 'twitch', label: 'Twitch' },
      { value: 'youtube', label: 'YouTube' },
      { value: 'vkvideo', label: 'VK Live' },
    ],
    placeholder: 'twitch',
  },
  { key: 'POLL_INTERVAL_MS', group: 'behavior', type: 'number', placeholder: '60000' },
  { key: 'ANNOUNCE_GRACE_MS', group: 'behavior', type: 'number', placeholder: '90000', hint: true },
  { key: 'OFFLINE_GRACE_MS', group: 'behavior', type: 'number', placeholder: '180000' },
  { key: 'ANNOUNCE_END', group: 'behavior', type: 'bool', placeholder: 'true' },
  { key: 'DRY_RUN', group: 'behavior', type: 'bool', placeholder: 'false' },
];

export interface GroupGuide {
  group: string;
  /** Ключи словаря: guide.<группа>.<номер>. */
  steps: string[];
  /** Внешние ссылки — только абсолютные https. */
  links?: Array<{ label: string; url: string }>;
}

const steps = (group: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `guide.${group}.${index + 1}`);

/** Пошаговые инструкции по группам: по смыслу совпадают с разделом «Настройка бота» в README. */
export const SETTING_GUIDES: GroupGuide[] = [
  {
    group: 'telegram',
    steps: steps('telegram', 5),
    links: [
      { label: '@BotFather', url: 'https://t.me/BotFather' },
      { label: '@userinfobot', url: 'https://t.me/userinfobot' },
    ],
  },
  { group: 'discord', steps: steps('discord', 4) },
  {
    group: 'twitch',
    steps: steps('twitch', 3),
    links: [{ label: 'dev.twitch.tv/console/apps', url: 'https://dev.twitch.tv/console/apps' }],
  },
  {
    group: 'youtube',
    steps: steps('youtube', 2),
    links: [{ label: 'youtube.com/account_advanced', url: 'https://www.youtube.com/account_advanced' }],
  },
  {
    group: 'vk',
    steps: steps('vk', 2),
    links: [{ label: 'vkvideo.ru', url: 'https://vkvideo.ru' }],
  },
];

/** Инструкции с готовыми текстами на языке; group — подпись группы, как у полей. */
export function settingGuides(lang: Lang = DEFAULT_LANGUAGE): GroupGuide[] {
  return SETTING_GUIDES.map((guide) => ({
    ...guide,
    group: t(lang, `settings.group.${guide.group}`),
    steps: guide.steps.map((key) => t(lang, key)),
  }));
}

const FIELDS_BY_KEY = new Map(SETTING_FIELDS.map((field) => [field.key, field]));

export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

/** Поле для браузера: тексты уже на нужном языке, group — подпись группы. */
export interface FieldView {
  key: string;
  group: string;
  label: string;
  type: FieldType;
  hint?: string;
  secret?: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  value: string;
  isSet: boolean;
}

export function settingsView(env: Env, lang: Lang = DEFAULT_LANGUAGE): FieldView[] {
  return SETTING_FIELDS.map((field) => {
    const raw = env[field.key]?.trim() ?? '';
    const { hint, options, group, ...rest } = field;
    return {
      ...rest,
      group: t(lang, `settings.group.${group}`),
      label: t(lang, `setting.${field.key}.label`),
      ...(hint ? { hint: t(lang, `setting.${field.key}.hint`) } : {}),
      ...(options
        ? { options: options.map((option) => ({ value: option.value, label: option.label ?? t(lang, option.labelKey ?? '') })) }
        : {}),
      isSet: raw !== '',
      value: field.secret && raw !== '' ? maskSecret(raw) : raw,
    };
  });
}

/**
 * Изменения из формы → значения для .env. Незнакомые ключи отбрасываем, пустой
 * секрет значит «оставить как есть»: браузер его настоящего значения не знает.
 */
export function settingsChanges(input: unknown, env: Env): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  const changes: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const field = FIELDS_BY_KEY.get(key);
    if (!field) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'boolean') continue;

    const value = typeof rawValue === 'boolean' ? String(rawValue) : rawValue.trim();
    if (field.secret && value === '') continue;
    const current = env[key]?.trim() ?? '';
    if (current === value) continue;
    // Форма показывает значение по умолчанию, когда в .env пусто, — это не изменение.
    if (current === '' && value === field.placeholder) continue;
    changes[key] = value;
  }
  return changes;
}
