import { describe, expect, it } from 'vitest';
import { SETTING_FIELDS, hasSecretKey, settingGuides, settingsChanges, settingsView, settingsViewV1 } from '../../src/web/settings.js';

describe('форма настроек', () => {
  it('подписи, подсказки и группы на русском по умолчанию', () => {
    const field = settingsView({}).find((item) => item.key === 'TELEGRAM_TOPIC_ID')!;

    expect(field).toMatchObject({ label: 'ID темы', group: 'Telegram', hint: 'Пусто — основная тема (General)' });
    expect(settingsView({}).find((item) => item.key === 'DRY_RUN')?.group).toBe('Поведение');
  });

  it('подписи, подсказки, группы и варианты select на английском', () => {
    const view = settingsView({}, 'en');
    const topic = view.find((item) => item.key === 'TELEGRAM_TOPIC_ID')!;
    const language = view.find((item) => item.key === 'APP_LANGUAGE')!;

    expect(topic).toMatchObject({ label: 'Topic ID', group: 'Telegram', hint: 'Empty — the main topic (General)' });
    expect(view.find((item) => item.key === 'DRY_RUN')?.group).toBe('Behavior');
    expect(language.options).toEqual([
      { value: '', label: 'Automatic (system language)' },
      { value: 'ru', label: 'Русский' },
      { value: 'en', label: 'English' },
    ]);
  });

  it('у каждого поля есть подпись на каждом языке, а подсказка — если она заявлена', () => {
    for (const lang of ['ru', 'en']) {
      for (const field of settingsView({}, lang)) {
        const source = SETTING_FIELDS.find((item) => item.key === field.key)!;
        expect(field.label, `${lang} ${field.key}`).not.toBe(`setting.${field.key}.label`);
        if (source.hint) expect(field.hint, `${lang} ${field.key}`).not.toBe(`setting.${field.key}.hint`);
      }
    }
  });

  it('инструкции приходят текстом на выбранном языке', () => {
    const guides = settingGuides('en');
    const telegram = guides.find((guide) => guide.group === 'Telegram')!;

    expect(telegram.steps[0]).toContain('@BotFather');
    expect(telegram.steps[0]).toContain('Bot token');
    for (const guide of guides) {
      for (const step of guide.steps) expect(step).not.toMatch(/^guide\./);
    }
  });

  it('язык: пустой выбор «авто» — не изменение, смена на en — изменение', () => {
    expect(settingsChanges({ APP_LANGUAGE: '', ANNOUNCE_LANGUAGE: '' }, {})).toEqual({});
    expect(settingsChanges({ APP_LANGUAGE: 'en', ANNOUNCE_LANGUAGE: 'ru' }, { APP_LANGUAGE: 'ru' })).toEqual({
      APP_LANGUAGE: 'en',
      ANNOUNCE_LANGUAGE: 'ru',
    });
  });
});

describe('настройки для API v1', () => {
  it('у секретов нет значения, только isSet; остальное как в панели', () => {
    const env = { TELEGRAM_BOT_TOKEN: '7712345678:AAHkSECRETxYz', TELEGRAM_CHAT_ID: '-100123' };
    const view = settingsViewV1(env);
    const token = view.find((item) => item.key === 'TELEGRAM_BOT_TOKEN')!;

    expect(token).toMatchObject({ secret: true, isSet: true });
    expect('value' in token).toBe(false);
    expect(JSON.stringify(view)).not.toContain('AAHkSECRET');
    expect(view.find((item) => item.key === 'TELEGRAM_CHAT_ID')).toEqual(
      settingsView(env).find((item) => item.key === 'TELEGRAM_CHAT_ID')
    );
  });

  it('секретный ключ в запросе находится с любым значением', () => {
    expect(hasSecretKey({ DISCORD_WEBHOOK_URL: '' })).toBe(true);
    expect(hasSecretKey({ TELEGRAM_CHAT_ID: '1', YOUTUBE_API_KEY: 'x' })).toBe(true);
    expect(hasSecretKey({ TELEGRAM_CHAT_ID: '1', UNKNOWN: 'x' })).toBe(false);
    expect(hasSecretKey(null)).toBe(false);
  });
});
