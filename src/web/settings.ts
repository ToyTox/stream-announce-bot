import type { Env } from '../config.js';

/**
 * Описание полей формы настроек. Панель рисует форму по этому списку,
 * так что новая настройка добавляется одной строкой здесь.
 */

export type FieldType = 'text' | 'number' | 'bool' | 'select';

export interface SettingField {
  key: string;
  group: string;
  label: string;
  type: FieldType;
  hint?: string;
  /** Значение не отдаётся в браузер целиком; пустое поле при сохранении — «не менять». */
  secret?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** Значение по умолчанию из loadConfig — чтобы форма показывала, что реально действует. */
  placeholder?: string;
}

export const SETTING_FIELDS: SettingField[] = [
  { key: 'TELEGRAM_BOT_TOKEN', group: 'Telegram', label: 'Токен бота', type: 'text', secret: true, hint: 'Выдаёт @BotFather' },
  { key: 'TELEGRAM_CHAT_ID', group: 'Telegram', label: 'ID группы', type: 'text', hint: 'Для ссылки t.me/c/2241331974/… это -1002241331974' },
  { key: 'TELEGRAM_TOPIC_ID', group: 'Telegram', label: 'ID темы', type: 'number', hint: 'Пусто — основная тема (General)' },
  { key: 'TELEGRAM_ADMIN_ID', group: 'Telegram', label: 'Ваш user ID', type: 'number', hint: 'Только от него бот принимает команды; нужен и для загрузки превью из панели' },

  { key: 'TWITCH_LOGIN', group: 'Twitch', label: 'Логин', type: 'text', hint: 'Как в адресе twitch.tv/<логин>' },
  { key: 'TWITCH_CLIENT_ID', group: 'Twitch', label: 'Client ID', type: 'text', hint: 'Из приложения на dev.twitch.tv' },
  { key: 'TWITCH_CLIENT_SECRET', group: 'Twitch', label: 'Client Secret', type: 'text', secret: true },

  { key: 'YOUTUBE_CHANNEL_ID', group: 'YouTube', label: 'ID канала', type: 'text', hint: 'Начинается с UC, 24 символа' },
  { key: 'YOUTUBE_API_KEY', group: 'YouTube', label: 'API-ключ', type: 'text', secret: true, hint: 'Необязательно: без ключа бот читает страницу /live' },

  { key: 'VKVIDEO_CHANNEL', group: 'VK', label: 'Канал VK Live', type: 'text', hint: 'Имя из адреса live.vkvideo.ru/<имя>' },
  { key: 'VKVIDEO_REPLAY_URL', group: 'VK', label: 'Ссылка на VK Video', type: 'text', hint: 'Канал с записями на vkvideo.ru — для анонса и итога эфира' },

  {
    key: 'PRIMARY_PLATFORM',
    group: 'Поведение',
    label: 'Название, игра и превью берутся с',
    type: 'select',
    options: [
      { value: 'twitch', label: 'Twitch' },
      { value: 'youtube', label: 'YouTube' },
      { value: 'vkvideo', label: 'VK Live' },
    ],
    placeholder: 'twitch',
  },
  { key: 'POLL_INTERVAL_MS', group: 'Поведение', label: 'Опрос площадок, мс', type: 'number', placeholder: '60000' },
  { key: 'ANNOUNCE_GRACE_MS', group: 'Поведение', label: 'Пауза перед анонсом, мс', type: 'number', placeholder: '90000', hint: 'Ждём, пока подключатся остальные площадки из OBS' },
  { key: 'OFFLINE_GRACE_MS', group: 'Поведение', label: 'Окончание эфира после молчания, мс', type: 'number', placeholder: '180000' },
  { key: 'ANNOUNCE_END', group: 'Поведение', label: 'Сообщение об окончании эфира', type: 'bool', placeholder: 'true' },
  { key: 'DRY_RUN', group: 'Поведение', label: 'Тестовый режим (ничего не отправлять)', type: 'bool', placeholder: 'false' },
];

export interface GroupGuide {
  group: string;
  steps: string[];
  /** Внешние ссылки — только абсолютные https. */
  links?: Array<{ label: string; url: string }>;
}

/** Пошаговые инструкции по группам: по смыслу совпадают с разделом «Настройка бота» в README. */
export const SETTING_GUIDES: GroupGuide[] = [
  {
    group: 'Telegram',
    steps: [
      'Напишите @BotFather команду /newbot и получите токен — вставьте его в поле «Токен бота».',
      'Добавьте бота в группу. Права администратора не обязательны, если в группе не запрещено писать участникам.',
      'ID группы: скопируйте ссылку на любое сообщение группы — t.me/c/2241331974/… — и добавьте -100 перед числом: -1002241331974.',
      'ID темы: если в группе включены темы, это первое число после ID группы в ссылке на сообщение из неё. Для основной темы (General, даже переименованной) оставьте поле пустым.',
      'Ваш user ID: напишите @userinfobot, он ответит вашим ID. Затем отправьте своему боту /start — без этого он не сможет писать вам в личку.',
    ],
    links: [
      { label: '@BotFather', url: 'https://t.me/BotFather' },
      { label: '@userinfobot', url: 'https://t.me/userinfobot' },
    ],
  },
  {
    group: 'Twitch',
    steps: [
      'Создайте приложение на dev.twitch.tv/console/apps: Redirect URL — https://localhost, тип клиента — «Конфиденциально».',
      'Скопируйте Client ID и Client Secret в поля ниже.',
      'Логин — как в адресе twitch.tv/<логин>.',
    ],
    links: [{ label: 'dev.twitch.tv/console/apps', url: 'https://dev.twitch.tv/console/apps' }],
  },
  {
    group: 'YouTube',
    steps: [
      'ID канала вида UC… возьмите на странице youtube.com/account_advanced. Ник @… не подходит.',
      'API-ключ необязателен: без него бот читает страницу /live.',
    ],
    links: [{ label: 'youtube.com/account_advanced', url: 'https://www.youtube.com/account_advanced' }],
  },
  {
    group: 'VK',
    steps: [
      'Канал VK Live: имя из адреса live.vkvideo.ru/<имя>.',
      'Для ссылки на записи укажите канал на vkvideo.ru.',
    ],
    links: [{ label: 'vkvideo.ru', url: 'https://vkvideo.ru' }],
  },
];

const FIELDS_BY_KEY = new Map(SETTING_FIELDS.map((field) => [field.key, field]));

export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

export interface FieldView extends SettingField {
  value: string;
  isSet: boolean;
}

export function settingsView(env: Env): FieldView[] {
  return SETTING_FIELDS.map((field) => {
    const raw = env[field.key]?.trim() ?? '';
    return {
      ...field,
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
