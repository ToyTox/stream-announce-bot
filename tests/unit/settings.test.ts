import { describe, expect, it } from 'vitest';
import { SETTING_FIELDS, settingGuides, settingsChanges, settingsView } from '../../src/web/settings.js';

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
