import type { Env } from '../config.js';
import { en } from './en.js';
import { ru } from './ru.js';

/**
 * Локализация: словари по ключам, выбор языка и откат на русский. Модуль общий для сервера
 * и десктопа. Новый язык — это файл словаря с тем же набором ключей, что в ru.ts, и строка в DICTIONARIES.
 */

/** Код языка: ключ в DICTIONARIES. */
export type Lang = string;
export type Params = Record<string, string | number>;

export const DICTIONARIES: Record<Lang, Record<string, string>> = { ru, en };
export const DEFAULT_LANGUAGE: Lang = 'ru';
/** Язык для локалей, которых нет среди словарей. */
const FOREIGN_LANGUAGE: Lang = 'en';

export const LANGUAGES: Lang[] = Object.keys(DICTIONARIES);

/** Известный код языка или undefined (пусто, неизвестное значение). */
export function normalizeLanguage(value: string | undefined | null): Lang | undefined {
  const code = value?.trim().toLowerCase();
  return code && Object.hasOwn(DICTIONARIES, code) ? code : undefined;
}

/** Авто-выбор по локали («ru-RU», «en_US»): язык из словарей, иначе английский; локали нет — русский. */
function languageFromLocale(locale: string | undefined): Lang {
  const primary = locale?.trim().split(/[-_]/)[0];
  if (!primary) return DEFAULT_LANGUAGE;
  return normalizeLanguage(primary) ?? (normalizeLanguage(FOREIGN_LANGUAGE) ?? DEFAULT_LANGUAGE);
}

/** Явная настройка важнее локали; неизвестное значение считается «авто». */
export function resolveLanguage(setting: string | undefined | null, locale?: string): Lang {
  return normalizeLanguage(setting) ?? languageFromLocale(locale);
}

let localeOverride: string | undefined;

/** Десктоп задаёт локаль системы из Electron (app.getLocale()); в терминале берётся из Intl. */
export function setSystemLocale(locale: string | undefined): void {
  localeOverride = locale;
}

export function systemLocale(): string {
  return localeOverride ?? Intl.DateTimeFormat().resolvedOptions().locale;
}

/** Язык интерфейса: APP_LANGUAGE, иначе язык системы. */
export function languageFromEnv(env: Env, locale: string = systemLocale()): Lang {
  return resolveLanguage(env.APP_LANGUAGE, locale);
}

/** Язык текстов анонса: ANNOUNCE_LANGUAGE, если пусто или неизвестно — язык интерфейса. */
export function announceLanguageFromEnv(env: Env, locale: string = systemLocale()): Lang {
  return normalizeLanguage(env.ANNOUNCE_LANGUAGE) ?? languageFromEnv(env, locale);
}

export function t(lang: Lang, key: string, params: Params = {}): string {
  const template = DICTIONARIES[lang]?.[key] ?? DICTIONARIES[DEFAULT_LANGUAGE]?.[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Все тексты языка для клиента панели; недостающие ключи добираются из русского. */
export function messagesFor(lang: Lang): Record<string, string> {
  return { ...DICTIONARIES[DEFAULT_LANGUAGE], ...DICTIONARIES[lang] };
}

export function languageOptions(): Array<{ code: Lang; name: string }> {
  return LANGUAGES.map((code) => ({ code, name: t(code, 'language.name') }));
}
