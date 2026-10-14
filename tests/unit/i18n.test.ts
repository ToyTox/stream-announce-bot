import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  DICTIONARIES,
  LANGUAGES,
  announceLanguageFromEnv,
  languageFromEnv,
  messagesFor,
  resolveLanguage,
  setSystemLocale,
  t,
} from '../../src/i18n/index.js';

afterEach(() => {
  setSystemLocale(undefined);
});

describe('словари', () => {
  it('у каждого языка тот же набор ключей, что у русского', () => {
    const reference = Object.keys(DICTIONARIES.ru!).sort();

    for (const language of LANGUAGES) {
      expect(Object.keys(DICTIONARIES[language]!).sort(), language).toEqual(reference);
    }
  });

  it('подстановки {имя} совпадают с русским текстом', () => {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

    for (const language of LANGUAGES) {
      for (const [key, text] of Object.entries(DICTIONARIES[language]!)) {
        expect(names(text), `${language}: ${key}`).toEqual(names(DICTIONARIES.ru![key]!));
      }
    }
  });
});

describe('t', () => {
  it('подставляет параметры', () => {
    expect(t('en', 'duration.hoursMin', { h: 2, m: 5 })).toBe('2 h 5 min');
  });

  it('неизвестный язык откатывается на русский', () => {
    expect(t('fr', 'duration.min', { m: 3 })).toBe('3 мин');
  });

  it('ключа нет ни в одном словаре — возвращается сам ключ', () => {
    expect(t('en', 'no.such.key')).toBe('no.such.key');
  });

  it('messagesFor добирает недостающие ключи из русского', () => {
    expect(messagesFor('fr')['app.name']).toBe('Анонсы стримов');
    expect(messagesFor('en')['app.name']).toBe('Stream Announcements');
  });
});

describe('resolveLanguage', () => {
  it('явная настройка важнее локали', () => {
    expect(resolveLanguage('en', 'ru-RU')).toBe('en');
    expect(resolveLanguage(' RU ', 'en-US')).toBe('ru');
  });

  it('пусто — язык по локали: русские локали на русский, остальные на английский', () => {
    expect(resolveLanguage('', 'ru-RU')).toBe('ru');
    expect(resolveLanguage(undefined, 'ru')).toBe('ru');
    expect(resolveLanguage('', 'en_GB')).toBe('en');
    expect(resolveLanguage('', 'de-DE')).toBe('en');
  });

  it('неизвестное значение считается «авто»', () => {
    expect(resolveLanguage('klingon', 'ru-RU')).toBe('ru');
    expect(resolveLanguage('klingon', 'de-DE')).toBe('en');
  });

  it('локали нет — русский', () => {
    expect(resolveLanguage('', undefined)).toBe('ru');
    expect(resolveLanguage('', '')).toBe('ru');
  });
});

describe('язык из env', () => {
  it('интерфейс: APP_LANGUAGE или язык системы', () => {
    expect(languageFromEnv({ APP_LANGUAGE: 'en' }, 'ru-RU')).toBe('en');
    expect(languageFromEnv({}, 'en-US')).toBe('en');
    setSystemLocale('ru-RU');
    expect(languageFromEnv({})).toBe('ru');
  });

  it('анонс: ANNOUNCE_LANGUAGE, пусто — язык интерфейса', () => {
    expect(announceLanguageFromEnv({ APP_LANGUAGE: 'ru', ANNOUNCE_LANGUAGE: 'en' }, 'ru-RU')).toBe('en');
    expect(announceLanguageFromEnv({ APP_LANGUAGE: 'en' }, 'ru-RU')).toBe('en');
    expect(announceLanguageFromEnv({ ANNOUNCE_LANGUAGE: 'xx' }, 'en-US')).toBe('en');
  });
});

describe('loadConfig: языки', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_CHAT_ID: '-100',
    TWITCH_LOGIN: 'me',
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'secret',
  };

  it('языки анонса и интерфейса задаются раздельно', () => {
    setSystemLocale('ru-RU');

    expect(loadConfig(base)).toMatchObject({ language: 'ru', announceLanguage: 'ru' });
    expect(loadConfig({ ...base, APP_LANGUAGE: 'en' })).toMatchObject({ language: 'en', announceLanguage: 'en' });
    expect(loadConfig({ ...base, ANNOUNCE_LANGUAGE: 'en' })).toMatchObject({ language: 'ru', announceLanguage: 'en' });
  });

  it('текст ошибки конфига локализуется, а message остаётся русским', () => {
    try {
      loadConfig({ ...base, PRIMARY_PLATFORM: 'kick' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('ожидается twitch');
      expect((error as { localize(lang: string): string }).localize('en')).toContain('expected twitch');
    }
  });
});
