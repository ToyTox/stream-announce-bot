import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '../../src/bot.js';
import type { Env } from '../../src/config.js';
import type { DiscordClient } from '../../src/discord/client.js';
import type { TelegramClient } from '../../src/telegram/client.js';
import { pushLog } from '../../src/log.js';
import { openDb } from '../../src/db.js';
import { DeviceStore } from '../../src/devices.js';
import { createPanel, type Panel, type PanelRuntime } from '../../src/web/server.js';
import { createHarness, liveStream, testConfig, type Harness } from '../helpers/announcerHarness.js';

/** Панель на случайном порту поверх тестового бота: настоящий HTTP, фейковый Telegram. */

const ADMIN = 42;

let harness: Harness;
let panel: Panel;
let port: number;
let runtime: PanelRuntime & { restart: ReturnType<typeof vi.fn> };
let env: Env;
let dir: string;
let envPath: string;

interface Reply {
  status: number;
  json: any;
}

function call(
  method: string,
  path: string,
  options: { body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  let payload: Buffer | undefined = options.raw;
  if (options.body !== undefined) {
    payload = Buffer.from(JSON.stringify(options.body));
    headers['content-type'] ??= 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const isJson = res.headers['content-type']?.includes('json');
        resolve({ status: res.statusCode ?? 0, json: isJson ? JSON.parse(text) : text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** GET с сырым телом: call() разбирает только текст и JSON. */
function rawGet(path: string): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function startPanel(
  configOverrides: Parameters<typeof testConfig>[0] = {},
  discord = false,
  telegram = true
): Promise<void> {
  harness = createHarness(configOverrides, undefined, { discord, telegram });
  const config = testConfig({
    telegram: telegram ? { botToken: 'token', chatId: '-100123', adminId: ADMIN } : undefined,
    twitch: { login: 'me', clientId: 'id', clientSecret: 'secret' },
    vkvideo: { channel: 'me' },
    ...configOverrides,
  });
  const bot: Bot = {
    config,
    store: harness.store,
    image: harness.image,
    telegram: telegram ? (harness.telegram as unknown as TelegramClient) : undefined,
    discord: discord ? (harness.discord as unknown as DiscordClient) : undefined,
    announcer: harness.announcer,
    tickNow: () => harness.announcer.tick(),
    stop: async () => {},
  };
  runtime = { bot, configError: null, restart: vi.fn(async () => {}) };

  dir = mkdtempSync(join(tmpdir(), 'panel-'));
  envPath = join(dir, '.env');
  writeFileSync(envPath, '# Токен от BotFather\nTELEGRAM_BOT_TOKEN=7712345678:AAHkSECRETxYz\nTELEGRAM_CHAT_ID=-100123\nVKVIDEO_CHANNEL=me\n');
  env = { TELEGRAM_BOT_TOKEN: '7712345678:AAHkSECRETxYz', TELEGRAM_CHAT_ID: '-100123', VKVIDEO_CHANNEL: 'me' };

  panel = createPanel({ runtime, env, envPath, version: '1.2.3' });
  return new Promise((resolve) => {
    panel.server.listen(0, '127.0.0.1', () => {
      port = (panel.server.address() as AddressInfo).port;
      resolve();
    });
  });
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await startPanel();
});

afterEach(async () => {
  await panel.close();
  harness.cleanup();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('панель: статус и сообщение', () => {
  it('отдаёт страницу панели', async () => {
    const reply = await call('GET', '/');

    expect(reply.status).toBe(200);
    expect(reply.json).toContain('<title>Анонсы стримов</title>');
  });

  it('статус отдаёт версию приложения', async () => {
    const reply = await call('GET', '/api/status');

    expect(reply.status).toBe(200);
    expect(reply.json.version).toBe('1.2.3');
  });

  it('статус показывает настроенные площадки и результат последней проверки', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);
    harness.watchers.vkvideo.state = new Error('ECONNRESET');

    const reply = await call('POST', '/api/probe', { body: {} });

    expect(reply.status).toBe(200);
    const byPlatform = Object.fromEntries(reply.json.platforms.map((p: any) => [p.platform, p]));
    expect(Object.keys(byPlatform)).toEqual(['twitch', 'vkvideo']);
    expect(byPlatform.twitch).toMatchObject({ state: 'live', url: 'https://twitch.tv/me' });
    expect(byPlatform.vkvideo).toMatchObject({ state: 'error', error: 'ECONNRESET' });
    expect(reply.json.broadcast).toMatchObject({ announcedAt: null });
  });

  it('текст из панели попадает в предпросмотр анонса', async () => {
    await call('PUT', '/api/text', { body: { text: 'Сегодня финал' } });

    const preview = await call('GET', '/api/preview');

    expect(harness.store.announceText()).toBe('Сегодня финал');
    expect(preview.json.announce).toContain('Сегодня финал');
    expect(preview.json.finished).toContain('Эфир завершён');
    expect(preview.json.photo).toBe('twitch');
  });

  it('загруженная картинка уходит в личку и становится превью анонсов', async () => {
    const reply = await call('PUT', '/api/image', {
      raw: Buffer.from([0xff, 0xd8, 0xff]),
      headers: { 'content-type': 'image/jpeg' },
    });

    expect(reply.status).toBe(200);
    expect(harness.telegram.uploadPhoto.mock.calls[0]?.[0]).toBe(ADMIN);
    expect(harness.store.announcePhoto()).toBe('uploaded-large');
    expect((await call('GET', '/api/preview')).json.photo).toBe('custom');
  });

  it('загруженные байты сохраняются на диск с исходным типом и отдаются без обращения к Telegram', async () => {
    await call('PUT', '/api/image', {
      raw: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      headers: { 'content-type': 'image/png' },
    });

    const reply = await rawGet('/api/image/file');

    expect(reply.type).toBe('image/png');
    expect(reply.body).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(harness.telegram.downloadFile).not.toHaveBeenCalled();
  });

  it('копии нет — предпросмотр один раз докачивает файл из Telegram как jpeg', async () => {
    harness.store.setAnnouncePhoto('old-file-id');

    const first = await rawGet('/api/image/file');
    const second = await rawGet('/api/image/file');

    expect(first.type).toBe('image/jpeg');
    expect(second.body).toEqual(first.body);
    expect(harness.telegram.downloadFile).toHaveBeenCalledTimes(1);
    expect(existsSync(join(harness.dataDir, 'announce-image.bin'))).toBe(true);
  });

  it('сброс картинки удаляет локальную копию', async () => {
    await call('PUT', '/api/image', { raw: Buffer.from([1, 2]), headers: { 'content-type': 'image/webp' } });

    await call('DELETE', '/api/image');

    expect(harness.store.announcePhoto()).toBeNull();
    expect(existsSync(join(harness.dataDir, 'announce-image.bin'))).toBe(false);
    expect((await call('GET', '/api/image/file')).status).toBe(404);
  });

  it('без TELEGRAM_ADMIN_ID картинка сохраняется локально, в личку не уходит', async () => {
    await panel.close();
    harness.cleanup();
    await startPanel({ telegram: { botToken: 'token', chatId: '-100123' } });

    const reply = await call('PUT', '/api/image', {
      raw: Buffer.from([1]),
      headers: { 'content-type': 'image/jpeg' },
    });

    expect(reply.status).toBe(200);
    expect(harness.telegram.uploadPhoto).not.toHaveBeenCalled();
    expect(harness.image.telegramFileId()).toBeNull();
    expect((await rawGet('/api/image/file')).body).toEqual(Buffer.from([1]));
    expect((await call('GET', '/api/status')).json).toMatchObject({ hasImage: true, adminSet: false, telegramSet: true });
  });
});

describe('панель: настройки', () => {
  it('секрет не уходит в браузер целиком', async () => {
    const reply = await call('GET', '/api/settings');
    const token = reply.json.fields.find((field: any) => field.key === 'TELEGRAM_BOT_TOKEN');

    expect(token.value).toBe('7712…xYz');
    expect(JSON.stringify(reply.json)).not.toContain('AAHkSECRET');
  });

  it('отдаёт инструкции групп, внешние ссылки только https', async () => {
    const reply = await call('GET', '/api/settings');
    const guides = reply.json.guides as Array<{ group: string; steps: string[]; links?: Array<{ url: string }> }>;

    for (const group of ['Telegram', 'Discord', 'Twitch', 'YouTube', 'VK']) {
      const guide = guides.find((item) => item.group === group);
      expect(guide?.steps.length).toBeGreaterThan(0);
    }
    for (const link of guides.flatMap((guide) => guide.links ?? [])) {
      expect(link.url).toMatch(/^https:\/\//);
    }
  });

  it('вебхук Discord маскируется в браузере и сохраняется в .env', async () => {
    const hook = 'https://discord.com/api/webhooks/123456789/SECRETtokenValue';
    const saved = await call('PUT', '/api/settings', { body: { values: { DISCORD_WEBHOOK_URL: hook } } });

    expect(saved.status).toBe(200);
    expect(saved.json.changed).toEqual(['DISCORD_WEBHOOK_URL']);
    expect(readFileSync(envPath, 'utf8')).toContain(`DISCORD_WEBHOOK_URL=${hook}`);
    expect(runtime.restart).toHaveBeenCalledWith(env);

    const reply = await call('GET', '/api/settings');
    const field = reply.json.fields.find((item: any) => item.key === 'DISCORD_WEBHOOK_URL');
    expect(field).toMatchObject({ secret: true, isSet: true, group: 'Discord' });
    expect(JSON.stringify(reply.json)).not.toContain('SECRETtoken');

    const kept = await call('PUT', '/api/settings', { body: { values: { DISCORD_WEBHOOK_URL: '' } } });
    expect(kept.json.changed).toEqual([]);
    expect(env.DISCORD_WEBHOOK_URL).toBe(hook);
  });

  it('чужой адрес вместо вебхука Discord не сохраняется', async () => {
    const before = readFileSync(envPath, 'utf8');

    const reply = await call('PUT', '/api/settings', { body: { values: { DISCORD_WEBHOOK_URL: 'https://example.com/api/webhooks/1/tok' } } });

    expect(reply.status).toBe(400);
    expect(reply.json.error).toContain('DISCORD_WEBHOOK_URL');
    expect(readFileSync(envPath, 'utf8')).toBe(before);
  });

  it('невалидные настройки не трогают .env и бота', async () => {
    const before = readFileSync(envPath, 'utf8');

    const reply = await call('PUT', '/api/settings', { body: { values: { TELEGRAM_CHAT_ID: '' } } });

    expect(reply.status).toBe(400);
    expect(reply.json.error).toContain('TELEGRAM_CHAT_ID');
    expect(readFileSync(envPath, 'utf8')).toBe(before);
    expect(runtime.restart).not.toHaveBeenCalled();
  });

  it('валидные настройки пишутся в .env с комментариями и перезапускают бота', async () => {
    const reply = await call('PUT', '/api/settings', {
      body: { values: { TELEGRAM_BOT_TOKEN: '', VKVIDEO_REPLAY_URL: 'https://vkvideo.ru/@me' } },
    });

    expect(reply.status).toBe(200);
    expect(reply.json.changed).toEqual(['VKVIDEO_REPLAY_URL']);
    expect(readFileSync(envPath, 'utf8')).toBe(
      '# Токен от BotFather\nTELEGRAM_BOT_TOKEN=7712345678:AAHkSECRETxYz\nTELEGRAM_CHAT_ID=-100123\nVKVIDEO_CHANNEL=me\nVKVIDEO_REPLAY_URL=https://vkvideo.ru/@me\n'
    );
    expect(env.VKVIDEO_REPLAY_URL).toBe('https://vkvideo.ru/@me');
    expect(runtime.restart).toHaveBeenCalledWith(env);
  });
});

describe('панель: импорт .env', () => {
  const imported = '# Свой файл\nTELEGRAM_BOT_TOKEN=999:NEW\nTELEGRAM_CHAT_ID=-100777\nTWITCH_LOGIN=me\nTWITCH_CLIENT_ID=id\nTWITCH_CLIENT_SECRET=secret\n';

  it('валидный файл заменяет .env целиком и перезапускает бота', async () => {
    const reply = await call('POST', '/api/import-env', { body: { content: imported } });

    expect(reply.status).toBe(200);
    expect(readFileSync(envPath, 'utf8')).toBe(imported);
    expect(env.TELEGRAM_CHAT_ID).toBe('-100777');
    // Ключ из старого .env, которого нет в новом, не остаётся в живом env.
    expect(env.VKVIDEO_CHANNEL).toBeUndefined();
    expect(runtime.restart).toHaveBeenCalledWith(env);
  });

  it('невалидный файл даёт 400 и не трогает .env', async () => {
    const before = readFileSync(envPath, 'utf8');

    const reply = await call('POST', '/api/import-env', { body: { content: 'TELEGRAM_BOT_TOKEN=1\n' } });

    expect(reply.status).toBe(400);
    expect(reply.json.error).toContain('TELEGRAM_CHAT_ID');
    expect(readFileSync(envPath, 'utf8')).toBe(before);
    expect(env.TELEGRAM_BOT_TOKEN).toBe('7712345678:AAHkSECRETxYz');
    expect(runtime.restart).not.toHaveBeenCalled();
  });

  it('запрос с чужого сайта отклоняется', async () => {
    const before = readFileSync(envPath, 'utf8');

    const reply = await call('POST', '/api/import-env', {
      body: { content: imported },
      headers: { origin: 'https://evil.example' },
    });

    expect(reply.status).toBe(403);
    expect(readFileSync(envPath, 'utf8')).toBe(before);
    expect(runtime.restart).not.toHaveBeenCalled();
  });
});

describe('панель: защита', () => {
  it('запрос с чужого сайта отклоняется', async () => {
    const reply = await call('PUT', '/api/text', {
      body: { text: 'взлом' },
      headers: { origin: 'https://evil.example' },
    });

    expect(reply.status).toBe(403);
    expect(harness.store.announceText()).toBeNull();
  });

  it('чужой Host отклоняется (DNS rebinding)', async () => {
    const reply = await call('GET', '/api/settings', { headers: { host: `evil.example:${port}` } });

    expect(reply.status).toBe(403);
  });

  it('POST без JSON отклоняется — такой браузер мог бы отправить с чужого сайта формой', async () => {
    const reply = await call('POST', '/api/test-message', {
      raw: Buffer.from('x'),
      headers: { 'content-type': 'text/plain' },
    });

    expect(reply.status).toBe(415);
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
  });
});

describe('панель: язык', () => {
  it('без настройки язык берётся из Accept-Language браузера', async () => {
    const ru = await call('GET', '/api/i18n');
    const en = await call('GET', '/api/i18n', { headers: { 'accept-language': 'en-US,en;q=0.9' } });
    const de = await call('GET', '/api/i18n', { headers: { 'accept-language': 'de-DE' } });

    expect(ru.json).toMatchObject({ language: 'ru', setting: '' });
    expect(en.json).toMatchObject({ language: 'en', setting: '' });
    expect(en.json.messages['ui.tab.status']).toBe('Status');
    expect(de.json.language).toBe('en');
    expect(en.json.languages).toEqual([
      { code: 'ru', name: 'Русский' },
      { code: 'en', name: 'English' },
    ]);
  });

  it('смена языка пишется в .env, не перезапускает бота и меняет язык бота на лету', async () => {
    const reply = await call('PUT', '/api/language', { body: { language: 'en' } });

    expect(reply.status).toBe(200);
    expect(readFileSync(envPath, 'utf8')).toContain('APP_LANGUAGE=en');
    expect(env.APP_LANGUAGE).toBe('en');
    expect(runtime.restart).not.toHaveBeenCalled();
    expect(runtime.bot?.config).toMatchObject({ language: 'en', announceLanguage: 'en' });
    expect((await call('GET', '/api/i18n')).json).toMatchObject({ language: 'en', setting: 'en' });
  });

  it('неизвестный язык отклоняется', async () => {
    const reply = await call('PUT', '/api/language', { body: { language: 'xx' } });

    expect(reply.status).toBe(400);
    expect(readFileSync(envPath, 'utf8')).not.toContain('APP_LANGUAGE');
  });

  it('ошибки API и форма настроек приходят на языке запроса', async () => {
    const headers = { 'accept-language': 'en-US' };

    const missing = await call('GET', '/api/nothing', { headers });
    const noImage = await call('GET', '/api/image/file', { headers });
    const settings = await call('GET', '/api/settings', { headers });
    const invalid = await call('PUT', '/api/settings', { headers, body: { values: { TELEGRAM_CHAT_ID: '' } } });

    expect(missing.json.error).toBe('Not found');
    expect(noImage.json.error).toBe('No custom preview set');
    expect(settings.json.fields.find((f: any) => f.key === 'TELEGRAM_BOT_TOKEN').label).toBe('Bot token');
    expect(invalid.json.error).toContain('Telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  });

  it('тестовое сообщение уходит на языке панели', async () => {
    await call('POST', '/api/test-message', { body: {}, headers: { 'accept-language': 'en' } });

    expect(harness.telegram.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Connection check'));
  });

  it('проверка связи шлёт тест в каждую площадку и возвращает результат по каждой', async () => {
    await panel.close();
    harness.cleanup();
    await startPanel({ discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' } }, true);

    const ok = await call('POST', '/api/test-message', { body: {} });

    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      ok: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'discord', ok: true },
      ],
    });
    expect(harness.discord.send.mock.calls[0]?.[0].embeds?.[0]?.description).toContain('Проверка связи');
  });

  it('проверка связи: сбой Discord не скрывает успех Telegram', async () => {
    await panel.close();
    harness.cleanup();
    await startPanel({ discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' } }, true);
    harness.discord.send.mockRejectedValueOnce(new Error('Discord недоступен'));

    const reply = await call('POST', '/api/test-message', { body: {} });

    expect(reply.status).toBe(200);
    expect(reply.json.ok).toBe(false);
    expect(reply.json.results).toEqual([
      { channel: 'telegram', label: 'Telegram', ok: true },
      { channel: 'discord', label: 'Discord', ok: false, error: 'Discord недоступен' },
    ]);
    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('статус сообщает, настроен ли Discord', async () => {
    expect((await call('GET', '/api/status')).json.discordSet).toBe(false);

    await panel.close();
    harness.cleanup();
    await startPanel({ discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' } }, true);

    expect((await call('GET', '/api/status')).json.discordSet).toBe(true);
  });

  it('тестовый анонс в Telegram: успех и 502 при ошибке отправки', async () => {
    const ok = await call('POST', '/api/test-announce/telegram', { body: {} });

    expect(ok.status).toBe(200);
    expect(harness.telegram.sendMessage).toHaveBeenCalledWith(expect.stringContaining('🧪 Тест'), { silent: true });

    harness.telegram.sendMessage.mockRejectedValueOnce(new Error('Telegram недоступен'));
    const failed = await call('POST', '/api/test-announce/telegram', { body: {} });

    expect(failed.status).toBe(502);
    expect(failed.json.error).toContain('Telegram недоступен');
  });

  it('тестовый анонс в Discord без настройки отклоняется понятным сообщением', async () => {
    const reply = await call('POST', '/api/test-announce/discord', { body: {}, headers: { 'accept-language': 'en' } });

    expect(reply.status).toBe(400);
    expect(reply.json.error).toBe('Discord is not configured: set the webhook in settings');
    expect(harness.discord.send).not.toHaveBeenCalled();
  });

  it('тестовый анонс в Discord: успех и 502 при ошибке отправки', async () => {
    await panel.close();
    harness.cleanup();
    await startPanel({ discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' } }, true);

    const ok = await call('POST', '/api/test-announce/discord', { body: {} });

    expect(ok.status).toBe(200);
    expect(harness.discord.send).toHaveBeenCalledTimes(1);
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();

    harness.discord.send.mockRejectedValueOnce(new Error('Discord недоступен'));
    const failed = await call('POST', '/api/test-announce/discord', { body: {} });

    expect(failed.status).toBe(502);
    expect(failed.json.error).toContain('Discord недоступен');
  });

  it('превью анонса — на языке анонса, не интерфейса', async () => {
    await panel.close();
    harness.cleanup();
    await startPanel({ language: 'ru', announceLanguage: 'en' });

    const preview = await call('GET', '/api/preview');

    expect(preview.json.announce.startsWith('Hello everyone')).toBe(true);
    expect(preview.json.finished).toContain('Stream ended, it lasted 2 h 47 min');
  });
});

describe('панель без Telegram', () => {
  const discordOnly = { discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' } };

  beforeEach(async () => {
    await panel.close();
    harness.cleanup();
    await startPanel(discordOnly, true, false);
  });

  it('статус показывает, что Telegram выключен, а Discord включён', async () => {
    const reply = await call('GET', '/api/status');

    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ running: true, telegramSet: false, adminSet: false, discordSet: true });
  });

  it('проверка связи идёт только в Discord', async () => {
    const reply = await call('POST', '/api/test-message', { body: {} });

    expect(reply.json).toEqual({ ok: true, results: [{ channel: 'discord', label: 'Discord', ok: true }] });
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('проверка связи: сбой единственной площадки виден в результате', async () => {
    harness.discord.send.mockRejectedValueOnce(new Error('Discord недоступен'));

    const reply = await call('POST', '/api/test-message', { body: {} });

    expect(reply.json.ok).toBe(false);
    expect(reply.json.results[0]).toMatchObject({ channel: 'discord', ok: false, error: 'Discord недоступен' });
  });

  it('тестовый анонс в Telegram отклоняется понятным сообщением', async () => {
    const reply = await call('POST', '/api/test-announce/telegram', { body: {}, headers: { 'accept-language': 'en' } });

    expect(reply.status).toBe(400);
    expect(reply.json.error).toBe('Telegram is not configured: set the bot token and group ID in settings');
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('картинка загружается, отдаётся и сбрасывается без Telegram', async () => {
    const put = await call('PUT', '/api/image', {
      raw: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      headers: { 'content-type': 'image/png' },
    });

    expect(put.status).toBe(200);
    expect(harness.telegram.uploadPhoto).not.toHaveBeenCalled();
    const file = await rawGet('/api/image/file');
    expect(file.type).toBe('image/png');
    expect(file.body).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await call('GET', '/api/preview')).json.photo).toBe('custom');
    expect((await call('GET', '/api/status')).json.hasImage).toBe(true);

    await call('DELETE', '/api/image');

    expect(existsSync(join(harness.dataDir, 'announce-image.bin'))).toBe(false);
    expect((await call('GET', '/api/image/file')).status).toBe(404);
    expect((await call('GET', '/api/preview')).json.photo).toBe('twitch');
  });

  it('тип и размер файла проверяются так же', async () => {
    const reply = await call('PUT', '/api/image', { raw: Buffer.from([1]), headers: { 'content-type': 'image/gif' } });

    expect(reply.status).toBe(415);
  });

  it('старая картинка Telegram без копии: ответ 404, а не 502, к Telegram не обращаемся', async () => {
    harness.store.setAnnouncePhoto('old-file-id');

    const file = await call('GET', '/api/image/file');

    expect(file.status).toBe(404);
    expect(harness.telegram.downloadFile).not.toHaveBeenCalled();
    expect((await call('GET', '/api/preview')).json.photo).toBe('twitch');
  });

  it('старая картинка Telegram с копией на диске отдаётся из копии', async () => {
    harness.image.set('old-file-id', { data: new Uint8Array([7, 7]), type: 'image/jpeg' });

    const file = await rawGet('/api/image/file');

    expect(file.body).toEqual(Buffer.from([7, 7]));
    expect(harness.telegram.downloadFile).not.toHaveBeenCalled();
  });

  it('врезка и предпросмотр работают', async () => {
    await call('PUT', '/api/text', { body: { text: 'Сегодня финал' } });

    const preview = await call('GET', '/api/preview');

    expect(preview.status).toBe(200);
    expect(preview.json.announce).toContain('Сегодня финал');
    expect(preview.json.finished).toContain('Эфир завершён');
  });
});

describe('панель: /api/v1', () => {
  it('info отдаёт версию API и версию приложения', async () => {
    const reply = await call('GET', '/api/v1/info');

    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ apiVersion: 1, version: '1.2.3' });
  });

  it('status совпадает со статусом панели и не содержит секретов', async () => {
    const v1 = await call('GET', '/api/v1/status');
    const panelStatus = await call('GET', '/api/status');

    expect(v1.status).toBe(200);
    expect(v1.json).toEqual(panelStatus.json);
    expect(v1.json).toMatchObject({ running: true, version: '1.2.3' });
    expect(JSON.stringify(v1.json)).not.toContain('AAHkSECRET');
  });

  it('status при незапущенном боте отдаёт причину', async () => {
    runtime.bot = null;
    runtime.configError = 'нет токена';

    const reply = await call('GET', '/api/v1/status');

    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ version: '1.2.3', running: false, configError: 'нет токена' });
  });

  it('logs отдаёт строки и учитывает after', async () => {
    pushLog('info', 'v1-первая');
    pushLog('warn', 'v1-вторая');

    const all = await call('GET', '/api/v1/logs');
    const first = all.json.lines.find((line: any) => line.text === 'v1-первая');
    const after = await call('GET', `/api/v1/logs?after=${first.seq}`);

    expect(all.status).toBe(200);
    expect(after.json.lines.map((line: any) => line.text)).toEqual(['v1-вторая']);
    expect(after.json).toEqual(await call('GET', `/api/logs?after=${first.seq}`).then((r) => r.json));
  });

  it('текст: GET, PUT и DELETE работают как в панели', async () => {
    const put = await call('PUT', '/api/v1/text', { body: { text: 'Сегодня финал' } });
    const get = await call('GET', '/api/v1/text');

    expect(put).toEqual({ status: 200, json: { text: 'Сегодня финал' } });
    expect(get).toEqual(await call('GET', '/api/text'));
    expect(harness.store.announceText()).toBe('Сегодня финал');

    const del = await call('DELETE', '/api/v1/text');

    expect(del).toEqual({ status: 200, json: { text: null } });
    expect(harness.store.announceText()).toBeNull();
  });

  it('предпросмотр совпадает с панельным и учитывает текст', async () => {
    await call('PUT', '/api/v1/text', { body: { text: 'Сегодня финал' } });

    const v1 = await call('GET', '/api/v1/preview');

    expect(v1.status).toBe(200);
    expect(v1.json).toEqual((await call('GET', '/api/preview')).json);
    expect(v1.json.announce).toContain('Сегодня финал');
    expect(v1.json.photo).toBe('twitch');
  });

  it('ссылки: GET и PUT работают как в панели, превью показывает отмеченные', async () => {
    const links = [
      { label: 'Kick', url: 'https://kick.com/me', always: true },
      { label: 'Boosty', url: 'https://boosty.to/me', always: false },
    ];

    const put = await call('PUT', '/api/v1/links', { body: { links } });
    const get = await call('GET', '/api/v1/links');
    const preview = await call('GET', '/api/preview');

    expect(put).toEqual({ status: 200, json: { links } });
    expect(get).toEqual(await call('GET', '/api/links'));
    expect(harness.store.staticLinks()).toEqual(links);
    expect(preview.json.announce).toContain('<a href="https://kick.com/me">Kick</a>');
    expect(preview.json.announce).not.toContain('Boosty');
    expect(preview.json.announce).not.toContain('twitch.tv');
    expect(preview.json.finished).not.toContain('kick.com');
  });

  it('ссылки: некорректный запрос отклоняется целиком и список не портится', async () => {
    const good = [{ label: 'Kick', url: 'https://kick.com/me', always: true }];
    await call('PUT', '/api/links', { body: { links: good } });

    for (const links of [
      [...good, { label: '', url: 'https://a.example', always: false }],
      [...good, { label: 'x', url: 'javascript:alert(1)', always: false }],
      [...good, { label: 'x', url: '/relative', always: false }],
      'не список',
    ]) {
      const reply = await call('PUT', '/api/v1/links', { body: { links } });
      expect(reply.status).toBe(400);
      expect(typeof reply.json.error).toBe('string');
    }

    expect(harness.store.staticLinks()).toEqual(good);
  });

  it('ссылки: отмеченные ссылки, не помещающиеся в подпись, отклоняются, неотмеченные принимаются', async () => {
    const big = (i: number, always: boolean) => ({ label: `L${i}`, url: `https://example.com/${i}/${'a'.repeat(300)}`, always });
    const items = (always: boolean) => [0, 1, 2, 3].map((i) => big(i, always));

    const rejected = await call('PUT', '/api/v1/links', { body: { links: items(true) } });
    expect(rejected.status).toBe(400);
    expect(typeof rejected.json.error).toBe('string');
    expect(harness.store.staticLinks()).toEqual([]);

    expect((await call('PUT', '/api/links', { body: { links: items(false) } })).status).toBe(200);
  });

  it('картинка: загрузка уходит в личку, файл отдаётся, удаление сбрасывает', async () => {
    const put = await call('PUT', '/api/v1/image', {
      raw: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      headers: { 'content-type': 'image/png' },
    });

    expect(put).toEqual({ status: 200, json: { ok: true } });
    expect(harness.telegram.uploadPhoto.mock.calls[0]?.[0]).toBe(ADMIN);
    const file = await rawGet('/api/v1/image/file');
    const old = await rawGet('/api/image/file');
    expect(file.type).toBe('image/png');
    expect(file.body).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(file).toEqual(old);
    expect((await call('GET', '/api/v1/preview')).json.photo).toBe('custom');

    const del = await call('DELETE', '/api/v1/image');

    expect(del).toEqual({ status: 200, json: { ok: true } });
    expect(harness.store.announcePhoto()).toBeNull();
    expect((await call('GET', '/api/v1/image/file')).status).toBe(404);
  });

  it('картинка неверного типа отклоняется', async () => {
    const reply = await call('PUT', '/api/v1/image', { raw: Buffer.from([1]), headers: { 'content-type': 'image/gif' } });
    const old = await call('PUT', '/api/image', { raw: Buffer.from([1]), headers: { 'content-type': 'image/gif' } });

    expect(reply.status).toBe(415);
    expect(reply).toEqual(old);
  });

  it('probe запускает проверку и отдаёт статус как в панели', async () => {
    harness.watchers.twitch.state = liveStream('twitch', harness.clock);

    const reply = await call('POST', '/api/v1/probe', { body: {} });

    expect(reply.status).toBe(200);
    expect(reply.json.platforms.find((p: any) => p.platform === 'twitch')).toMatchObject({ state: 'live' });
    expect(reply.json).toEqual((await call('GET', '/api/status')).json);
  });

  it('test-message отправляет сообщение так же, как старый путь', async () => {
    const v1 = await call('POST', '/api/v1/test-message', { body: {} });
    const old = await call('POST', '/api/test-message', { body: {} });

    expect(v1.status).toBe(200);
    expect(v1.json).toEqual({ ok: true, results: [{ channel: 'telegram', label: 'Telegram', ok: true }] });
    expect(v1).toEqual(old);
    expect(harness.telegram.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('test-announce: Telegram работает, ненастроенный Discord даёт ту же ошибку', async () => {
    const telegram = await call('POST', '/api/v1/test-announce/telegram', { body: {} });
    const discord = await call('POST', '/api/v1/test-announce/discord', { body: {}, headers: { 'accept-language': 'en' } });
    const old = await call('POST', '/api/test-announce/discord', { body: {}, headers: { 'accept-language': 'en' } });

    expect(telegram).toEqual({ status: 200, json: { ok: true } });
    expect(discord.status).toBe(400);
    expect(discord).toEqual(old);
  });

  it('test-announce в Discord через v1 уходит в Discord, а не в Telegram', async () => {
    await panel.close();
    harness.cleanup();
    await startPanel({ discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' } }, true);

    const reply = await call('POST', '/api/v1/test-announce/discord', { body: {} });

    expect(reply).toEqual({ status: 200, json: { ok: true } });
    expect(harness.discord.send).toHaveBeenCalled();
    expect(harness.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('GET /api/v1/settings не отдаёт секреты и маски, но показывает isSet', async () => {
    const v1 = await call('GET', '/api/v1/settings');
    const old = await call('GET', '/api/settings');
    const token = v1.json.fields.find((field: any) => field.key === 'TELEGRAM_BOT_TOKEN');

    expect(v1.status).toBe(200);
    expect(token).toMatchObject({ secret: true, isSet: true });
    expect('value' in token).toBe(false);
    expect(JSON.stringify(v1.json)).not.toContain('AAHkSECRET');
    expect(JSON.stringify(v1.json)).not.toContain('7712');
    expect(JSON.stringify(v1.json)).not.toContain('xYz');
    expect(v1.json.guides).toBeUndefined();
    expect(v1.json.configError).toBe(old.json.configError);
    for (const field of v1.json.fields.filter((item: any) => !item.secret)) {
      expect(field).toEqual(old.json.fields.find((item: any) => item.key === field.key));
    }
  });

  it('PUT /api/v1/settings меняет несекретное поле, перезапускает бота', async () => {
    const reply = await call('PUT', '/api/v1/settings', { body: { values: { VKVIDEO_REPLAY_URL: 'https://vkvideo.ru/@me' } } });

    expect(reply.status).toBe(200);
    expect(reply.json.changed).toEqual(['VKVIDEO_REPLAY_URL']);
    expect(readFileSync(envPath, 'utf8')).toContain('VKVIDEO_REPLAY_URL=https://vkvideo.ru/@me');
    expect(runtime.restart).toHaveBeenCalledWith(env);
  });

  it('PUT /api/v1/settings с невалидным значением даёт 400 без записи', async () => {
    const before = readFileSync(envPath, 'utf8');

    const reply = await call('PUT', '/api/v1/settings', { body: { values: { TELEGRAM_CHAT_ID: '' } } });

    expect(reply.status).toBe(400);
    expect(reply.json.error).toContain('TELEGRAM_CHAT_ID');
    expect(readFileSync(envPath, 'utf8')).toBe(before);
    expect(runtime.restart).not.toHaveBeenCalled();
  });

  it('PUT /api/v1/settings с секретным ключом отклоняется целиком', async () => {
    const before = readFileSync(envPath, 'utf8');

    for (const secret of ['new-token', '']) {
      const reply = await call('PUT', '/api/v1/settings', {
        body: { values: { VKVIDEO_REPLAY_URL: 'https://vkvideo.ru/@me', TELEGRAM_BOT_TOKEN: secret } },
        headers: { 'accept-language': 'en' },
      });
      expect(reply.status).toBe(400);
      expect(reply.json.error).toBe('Secrets cannot be changed via the API: set them in the panel');
    }
    expect(readFileSync(envPath, 'utf8')).toBe(before);
    expect(env.VKVIDEO_REPLAY_URL).toBeUndefined();
    expect(runtime.restart).not.toHaveBeenCalled();
  });

  it('запись с чужим Host или Origin отклоняется', async () => {
    const host = await call('PUT', '/api/v1/text', { body: { text: 'x' }, headers: { host: `evil.example:${port}` } });
    const origin = await call('POST', '/api/v1/probe', { body: {}, headers: { origin: 'https://evil.example' } });
    const image = await call('PUT', '/api/v1/image', {
      raw: Buffer.from([1]),
      headers: { 'content-type': 'image/png', origin: 'https://evil.example' },
    });

    expect(host.status).toBe(403);
    expect(origin.status).toBe(403);
    expect(image.status).toBe(403);
    expect(harness.store.announceText()).toBeNull();
    expect(harness.store.announcePhoto()).toBeNull();
  });

  describe('без Telegram', () => {
    beforeEach(async () => {
      await panel.close();
      harness.cleanup();
      await startPanel({ discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' } }, true, false);
    });

    it('картинка хранится локально, неверный тип отклоняется', async () => {
      const put = await call('PUT', '/api/v1/image', {
        raw: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        headers: { 'content-type': 'image/png' },
      });
      const bad = await call('PUT', '/api/v1/image', { raw: Buffer.from([1]), headers: { 'content-type': 'image/gif' } });

      expect(put.status).toBe(200);
      expect(bad.status).toBe(415);
      expect(harness.telegram.uploadPhoto).not.toHaveBeenCalled();
      expect((await rawGet('/api/v1/image/file')).body).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      await call('DELETE', '/api/v1/image');

      expect(existsSync(join(harness.dataDir, 'announce-image.bin'))).toBe(false);
    });

    it('test-message идёт в Discord, test-announce в Telegram отвечает той же ошибкой', async () => {
      const message = await call('POST', '/api/v1/test-message', { body: {} });
      const headers = { 'accept-language': 'en' };
      const v1 = await call('POST', '/api/v1/test-announce/telegram', { body: {}, headers });
      const old = await call('POST', '/api/test-announce/telegram', { body: {}, headers });

      expect(message.json).toEqual({ ok: true, results: [{ channel: 'discord', label: 'Discord', ok: true }] });
      expect(v1.status).toBe(400);
      expect(v1).toEqual(old);
    });
  });

  it('неизвестный путь и метод дают 404 с JSON-ошибкой на языке запроса', async () => {
    const unknown = await call('GET', '/api/v1/nope');
    const method = await call('POST', '/api/v1/status', { body: {} });
    const en = await call('GET', '/api/v1/nope', { headers: { 'accept-language': 'en-US' } });

    expect(unknown).toEqual({ status: 404, json: { error: 'Не найдено' } });
    expect(method.status).toBe(404);
    expect(en.json).toEqual({ error: 'Not found' });
  });

  it('чужой Host и Origin отклоняются, как и в панели', async () => {
    const host = await call('GET', '/api/v1/status', { headers: { host: `evil.example:${port}` } });
    const origin = await call('GET', '/api/v1/info', { headers: { origin: 'https://evil.example' } });

    expect(host.status).toBe(403);
    expect(origin.status).toBe(403);
  });
});

describe('панель: Bearer для /api/v1', () => {
  function registry(): { devices: DeviceStore; close(): void } {
    env.DATABASE_PATH = join(dir, 'bot.db');
    const db = openDb(env.DATABASE_PATH);
    return { devices: new DeviceStore(db), close: () => db.close() };
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('верный токен пропускает запрос и отмечает время использования', async () => {
    const { devices, close } = registry();
    const { device, token } = devices.issue('Pixel');

    const reply = await call('GET', '/api/v1/info', { headers: bearer(token) });

    expect(reply.status).toBe(200);
    expect(devices.list().find((d) => d.id === device.id)?.lastUsedAt).not.toBeNull();
    close();
  });

  it('неверный, отозванный токен и кривой заголовок дают 401', async () => {
    const { devices, close } = registry();
    const { device, token } = devices.issue('Pixel');
    devices.revoke(device.id);

    for (const headers of [bearer('A'.repeat(43)), bearer(token), bearer('short'), { authorization: 'Basic abc' }, { authorization: 'Bearer' }]) {
      const reply = await call('GET', '/api/v1/info', { headers });
      expect(reply.status).toBe(401);
      expect(reply.json.error).toContain('токен');
    }
    close();
  });

  it('/api/v1/links требует действующий токен', async () => {
    const { devices, close } = registry();
    const { token } = devices.issue('Pixel');

    expect((await call('GET', '/api/v1/links', { headers: bearer('A'.repeat(43)) })).status).toBe(401);
    expect((await call('PUT', '/api/v1/links', { body: { links: [] }, headers: bearer('A'.repeat(43)) })).status).toBe(401);
    expect((await call('GET', '/api/v1/links', { headers: bearer(token) })).status).toBe(200);
    close();
  });

  it('без заголовка с localhost запрос проходит как раньше', async () => {
    expect((await call('GET', '/api/v1/info')).status).toBe(200);
  });

  it('/api/* панели не зависит от заголовка Authorization', async () => {
    expect((await call('GET', '/api/status', { headers: { authorization: 'Bearer garbage' } })).status).toBe(200);
  });

  it('при неработающем боте реестр работает, 500 нет', async () => {
    runtime.bot = null;
    runtime.configError = 'нет токена';
    const { devices, close } = registry();
    const { token } = devices.issue('Pixel');

    expect((await call('GET', '/api/v1/status', { headers: bearer(token) })).status).toBe(200);
    expect((await call('GET', '/api/v1/status', { headers: bearer('A'.repeat(43)) })).status).toBe(401);
    close();
  });

  it('если базу не открыть, токен даёт 401, а не 500', async () => {
    env.DATABASE_PATH = join(dir, 'нет', '\0', 'bot.db');

    const reply = await call('GET', '/api/v1/info', { headers: bearer('A'.repeat(43)) });

    expect(reply.status).toBe(401);
  });
});

describe('панель: сопряжение устройства', () => {
  function registry(): { devices: DeviceStore; close(): void } {
    env.DATABASE_PATH = join(dir, 'bot.db');
    const db = openDb(env.DATABASE_PATH);
    return { devices: new DeviceStore(db), close: () => db.close() };
  }
  const pair = (code: unknown, name: unknown = 'Pixel', headers: Record<string, string> = {}) =>
    call('POST', '/api/v1/pair', { body: { code, name }, headers });

  it('код из панели меняется на токен, с которым работает /api/v1', async () => {
    const { devices, close } = registry();

    const issued = await call('POST', '/api/pairing', { body: {} });
    const paired = await pair(issued.json.code, ' Pixel ');
    const info = await call('GET', '/api/v1/info', { headers: { authorization: `Bearer ${paired.json.token}` } });

    expect(issued.status).toBe(200);
    expect(issued.json.expiresAt).toBeGreaterThan(Date.now());
    expect(paired.status).toBe(200);
    expect(paired.json.device).toMatchObject({ name: 'Pixel', revokedAt: null });
    expect(JSON.stringify(paired.json)).not.toContain('hash');
    expect(info.status).toBe(200);
    expect(devices.list()).toHaveLength(1);
    close();
  });

  it('повторный обмен того же кода и неверный код дают одинаковый 401', async () => {
    const { devices, close } = registry();
    const issued = await call('POST', '/api/pairing', { body: {} });
    await pair(issued.json.code);

    const again = await pair(issued.json.code);
    const wrong = await pair('A'.repeat(22));
    const short = await pair('x');

    expect(again.status).toBe(401);
    expect(wrong).toEqual(again);
    expect(short).toEqual(again);
    expect(devices.list()).toHaveLength(1);
    close();
  });

  it('невалидное имя и тело дают 400 и не гасят код', async () => {
    const { devices, close } = registry();
    const issued = await call('POST', '/api/pairing', { body: {} });

    expect((await pair(issued.json.code, '')).status).toBe(400);
    expect((await pair(issued.json.code, '   ')).status).toBe(400);
    expect((await pair(issued.json.code, 'x'.repeat(65))).status).toBe(400);
    expect((await pair(issued.json.code, 42)).status).toBe(400);
    expect((await pair(undefined)).status).toBe(400);
    expect((await call('POST', '/api/v1/pair', { raw: Buffer.from('{'), headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect(devices.list()).toHaveLength(0);
    expect((await pair(issued.json.code)).status).toBe(200);
    close();
  });

  it('новый код аннулирует прежний', async () => {
    registry().close();
    const first = await call('POST', '/api/pairing', { body: {} });
    const second = await call('POST', '/api/pairing', { body: {} });

    expect((await pair(first.json.code)).status).toBe(401);
    expect((await pair(second.json.code)).status).toBe(200);
  });

  it('/api/v1/pair проходит без Bearer, а с чужим Bearer не проверяет его', async () => {
    const { close } = registry();
    const issued = await call('POST', '/api/pairing', { body: {} });

    const reply = await pair(issued.json.code, 'Pixel', { authorization: 'Bearer garbage' });

    expect(reply.status).toBe(200);
    close();
  });

  it('/api/pairing есть только у панели', async () => {
    expect((await call('POST', '/api/v1/pairing', { body: {} })).status).toBe(404);
  });

  it('чужой Host у обоих маршрутов даёт 403', async () => {
    registry().close();
    const headers = { host: `evil.example:${port}` };

    expect((await call('POST', '/api/pairing', { body: {}, headers })).status).toBe(403);
    expect((await pair('A'.repeat(22), 'Pixel', headers)).status).toBe(403);
  });

  it('если базу не открыть, оба маршрута отвечают 503', async () => {
    env.DATABASE_PATH = join(dir, 'нет', '\0', 'bot.db');

    const issued = await call('POST', '/api/pairing', { body: {} });
    const paired = await pair('A'.repeat(22));

    expect(issued.status).toBe(503);
    expect(paired.status).toBe(503);
  });
});
