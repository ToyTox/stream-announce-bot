import type { SettingFieldView, SettingsResponse, TestMessageDelivery, TestMessageResult } from '../../shared/api-v1.js';

const setting = { group: 'Telegram', label: 'Настройка', type: 'text', isSet: true } as const;
const publicField = { ...setting, key: 'TELEGRAM_CHAT_ID', value: '-100123' } satisfies SettingFieldView;
const secretField = { ...setting, key: 'TELEGRAM_BOT_TOKEN', secret: true } satisfies SettingFieldView;
const settings: SettingsResponse = { fields: [publicField, secretField], configError: null };
const exposedSecret = { ...publicField, key: secretField.key };

// @ts-expect-error Секретный ключ нельзя объявить публичным полем.
const publicSecret: SettingFieldView = exposedSecret;
// @ts-expect-error Ответ настроек также запрещает публичную форму секретного ключа.
const invalidSettings: SettingsResponse = { ...settings, fields: [exposedSecret] };
// @ts-expect-error У секретного поля не должно быть значения.
const secretValue: SettingFieldView = { ...secretField, value: '••••' };
// @ts-expect-error У публичного поля должно быть значение.
const missingValue: SettingFieldView = { ...setting, key: publicField.key };

const telegramSuccess = { channel: 'telegram', label: 'Telegram', ok: true } satisfies TestMessageDelivery;
const discordSuccess = { channel: 'discord', label: 'Discord', ok: true } satisfies TestMessageDelivery;
const telegramFailure = { channel: 'telegram', label: 'Telegram', ok: false, error: 'Сбой' } satisfies TestMessageDelivery;
const discordFailure = { channel: 'discord', label: 'Discord', ok: false, error: 'Сбой' } satisfies TestMessageDelivery;

const noTargets: TestMessageResult = { ok: true, results: [] };
const allDelivered: TestMessageResult = { ok: true, results: [telegramSuccess, discordSuccess] };
const firstFailed: TestMessageResult = { ok: false, results: [telegramFailure, discordSuccess] };
const secondFailed: TestMessageResult = { ok: false, results: [telegramSuccess, discordFailure] };

// @ts-expect-error При отсутствии доставок итог успешный.
const emptyFailure: TestMessageResult = { ok: false, results: [] };
// @ts-expect-error Отрицательный итог требует хотя бы одного сбоя.
const missingFailure: TestMessageResult = { ok: false, results: [telegramSuccess, discordSuccess] };
// @ts-expect-error Сбой исключает положительный итог.
const falseSuccess: TestMessageResult = { ok: true, results: [telegramSuccess, discordFailure] };
