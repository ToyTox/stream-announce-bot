import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '../../src/bot.js';
import type { Env } from '../../src/config.js';
import type { TelegramClient } from '../../src/telegram/client.js';
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

function startPanel(configOverrides: Parameters<typeof testConfig>[0] = {}): Promise<void> {
  harness = createHarness();
  const config = testConfig({
    telegram: { botToken: 'token', chatId: '-100123', adminId: ADMIN },
    twitch: { login: 'me', clientId: 'id', clientSecret: 'secret' },
    vkvideo: { channel: 'me' },
    ...configOverrides,
  });
  const bot: Bot = {
    config,
    store: harness.store,
    telegram: harness.telegram as unknown as TelegramClient,
    announcer: harness.announcer,
    tickNow: () => harness.announcer.tick(),
    stop: async () => {},
  };
  runtime = { bot, configError: null, restart: vi.fn(async () => {}) };

  dir = mkdtempSync(join(tmpdir(), 'panel-'));
  envPath = join(dir, '.env');
  writeFileSync(envPath, '# Токен от BotFather\nTELEGRAM_BOT_TOKEN=7712345678:AAHkSECRETxYz\nTELEGRAM_CHAT_ID=-100123\nVKVIDEO_CHANNEL=me\n');
  env = { TELEGRAM_BOT_TOKEN: '7712345678:AAHkSECRETxYz', TELEGRAM_CHAT_ID: '-100123', VKVIDEO_CHANNEL: 'me' };

  panel = createPanel({ runtime, env, envPath });
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

  it('без TELEGRAM_ADMIN_ID картинку загрузить нельзя', async () => {
    await panel.close();
    harness.cleanup();
    await startPanel({ telegram: { botToken: 'token', chatId: '-100123' } });

    const reply = await call('PUT', '/api/image', {
      raw: Buffer.from([1]),
      headers: { 'content-type': 'image/jpeg' },
    });

    expect(reply.status).toBe(400);
    expect(harness.telegram.uploadPhoto).not.toHaveBeenCalled();
  });
});

describe('панель: настройки', () => {
  it('секрет не уходит в браузер целиком', async () => {
    const reply = await call('GET', '/api/settings');
    const token = reply.json.fields.find((field: any) => field.key === 'TELEGRAM_BOT_TOKEN');

    expect(token.value).toBe('7712…xYz');
    expect(JSON.stringify(reply.json)).not.toContain('AAHkSECRET');
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
