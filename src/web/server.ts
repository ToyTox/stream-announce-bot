import { parse as parseEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelUrl } from '../announcer.js';
import type { Bot } from '../bot.js';
import { ConfigError, loadConfig, type Env } from '../config.js';
import { recentLogs } from '../log.js';
import { TelegramError } from '../telegram/client.js';
import { PLATFORMS, PLATFORM_LABELS } from '../types.js';
import { replaceEnvFile, writeEnvFile } from './envFile.js';
import { settingsChanges, settingsView } from './settings.js';

/**
 * Локальная панель: настройки, статус, превью сообщений и лог. Слушает только
 * 127.0.0.1 и отвечает только на Host localhost — из сети и с чужих сайтов недоступна.
 */

export interface PanelRuntime {
  bot: Bot | null;
  configError: string | null;
  restart(env: Env): Promise<void>;
}

export interface PanelDeps {
  runtime: PanelRuntime;
  /** Живой env процесса: после сохранения настроек обновляется вместе с .env. */
  env: Env;
  envPath: string;
  /** Значения, которых нет в .env, но нужны боту (например, путь к базе в десктопном приложении). */
  defaults?: Env;
}

export interface Panel {
  server: Server;
  /** Реальный порт после listen: при порте 0 его выбирает система. */
  port: number;
  close(): Promise<void>;
}

/** Ищем web/index.html вверх по дереву: код может лежать в dist/ или в dist-desktop/src/. */
function findIndexHtml(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, 'web', 'index.html');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Не найден web/index.html');
}

const INDEX_HTML = findIndexHtml();
const JSON_LIMIT = 64 * 1024;
/** Лимит Telegram на фото. */
const IMAGE_LIMIT = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `Слишком большой файл: максимум ${Math.round(limit / 1024 / 1024)} МБ`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, JSON_LIMIT)).toString('utf8');
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

/**
 * Защита от сайтов, которые попробуют дёрнуть localhost из вашего браузера:
 * чужой Host (DNS rebinding) и чужой Origin отклоняем, а POST принимаем только
 * с JSON — такой запрос браузер не отправит на другой сайт без разрешения CORS.
 */
function checkTrusted(req: IncomingMessage, port: number): void {
  const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  const host = req.headers.host ?? '';
  if (!allowedHosts.includes(host)) throw new HttpError(403, 'Панель доступна только с этого компьютера');

  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.some((allowed) => origin === `http://${allowed}`)) {
    throw new HttpError(403, 'Запрос с чужого сайта отклонён');
  }

  const type = req.headers['content-type'] ?? '';
  if (req.method === 'POST' && !type.startsWith('application/json')) {
    throw new HttpError(415, 'Ожидается application/json');
  }
}

function requireBot(runtime: PanelRuntime): Bot {
  if (runtime.bot) return runtime.bot;
  throw new HttpError(503, runtime.configError ? `Бот не запущен: ${runtime.configError}` : 'Бот не запущен');
}

/** Ссылка на сообщение в супергруппе: -1002241331974 → t.me/c/2241331974/<id>. */
function messageUrl(chatId: string | null, messageId: number | null): string | null {
  if (!chatId?.startsWith('-100') || messageId === null) return null;
  return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPanel(deps: PanelDeps): Panel {
  const { runtime, env, envPath, defaults = {} } = deps;
  /** Последнее скачанное превью: Telegram отдаёт файл по file_id, качать его на каждый показ незачем. */
  let imageCache: { fileId: string; data: Uint8Array } | null = null;

  function status() {
    const bot = runtime.bot;
    if (!bot) return { running: false, configError: runtime.configError };

    const broadcast = bot.announcer.status();
    const states = new Map(bot.announcer.platformStates().map((state) => [state.platform, state]));
    return {
      running: true,
      configError: null,
      dryRun: bot.config.dryRun,
      adminSet: bot.config.telegram.adminId !== undefined,
      broadcast: broadcast && {
        ...broadcast,
        messageUrl: messageUrl(broadcast.chatId, broadcast.messageId),
      },
      platforms: PLATFORMS.flatMap((platform) => {
        const url = channelUrl(bot.config, platform);
        if (!url) return [];
        const state = states.get(platform);
        return [{ platform, label: PLATFORM_LABELS[platform], url, state: state?.state ?? 'pending', error: state?.error, checkedAt: state?.checkedAt ?? null }];
      }),
      text: bot.store.announceText(),
      hasImage: bot.store.announcePhoto() !== null,
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const key = `${req.method} ${url.pathname}`;

    switch (key) {
      case 'GET /':
      case 'GET /index.html': {
        const html = await readFile(INDEX_HTML);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      case 'GET /api/status':
        return sendJson(res, 200, status());

      case 'POST /api/probe':
        await requireBot(runtime).tickNow();
        return sendJson(res, 200, status());

      case 'POST /api/test-message': {
        const bot = requireBot(runtime);
        try {
          await bot.telegram.sendMessage('✅ Проверка связи из панели: бот анонсов на месте');
        } catch (error) {
          throw new HttpError(502, errorText(error));
        }
        return sendJson(res, 200, { ok: true });
      }

      case 'GET /api/text':
        return sendJson(res, 200, { text: requireBot(runtime).store.announceText() });

      case 'PUT /api/text': {
        const store = requireBot(runtime).store;
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (text) store.setAnnounceText(text);
        else store.clearAnnounceText();
        return sendJson(res, 200, { text: store.announceText() });
      }

      case 'DELETE /api/text':
        requireBot(runtime).store.clearAnnounceText();
        return sendJson(res, 200, { text: null });

      case 'PUT /api/image': {
        const bot = requireBot(runtime);
        const adminId = bot.config.telegram.adminId;
        if (adminId === undefined) {
          throw new HttpError(400, 'Укажите в настройках «Ваш user ID»: картинка загружается в Telegram через вашу личку с ботом');
        }
        const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
        if (!IMAGE_TYPES.has(type)) throw new HttpError(415, 'Подходят только JPEG, PNG и WebP');

        const data = await readBody(req, IMAGE_LIMIT);
        let fileId: string | undefined;
        try {
          const message = await bot.telegram.uploadPhoto(adminId, data, type, 'Превью для анонсов — загружено из панели');
          fileId = message.photo?.at(-1)?.file_id;
        } catch (error) {
          const hint =
            error instanceof TelegramError && error.code === 'chat_not_found'
              ? ' — напишите боту в личку /start, чтобы он мог вам писать'
              : '';
          throw new HttpError(502, `${errorText(error)}${hint}`);
        }
        if (!fileId) throw new HttpError(502, 'Telegram не вернул file_id картинки');

        bot.store.setAnnouncePhoto(fileId);
        imageCache = { fileId, data };
        return sendJson(res, 200, { ok: true });
      }

      case 'GET /api/image/file': {
        const bot = requireBot(runtime);
        const fileId = bot.store.announcePhoto();
        if (!fileId) throw new HttpError(404, 'Своё превью не задано');
        if (imageCache?.fileId !== fileId) {
          try {
            imageCache = { fileId, data: await bot.telegram.downloadFile(fileId) };
          } catch (error) {
            throw new HttpError(502, errorText(error));
          }
        }
        // Фото Telegram всегда пережимает в JPEG.
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        res.end(imageCache.data);
        return;
      }

      case 'DELETE /api/image':
        requireBot(runtime).store.clearAnnouncePhoto();
        imageCache = null;
        return sendJson(res, 200, { ok: true });

      case 'GET /api/preview': {
        const bot = requireBot(runtime);
        return sendJson(res, 200, {
          ...bot.announcer.preview(),
          photo: bot.store.announcePhoto() ? 'custom' : 'twitch',
        });
      }

      case 'GET /api/settings':
        return sendJson(res, 200, { fields: settingsView(env), configError: runtime.configError });

      case 'PUT /api/settings': {
        const body = await readJson(req);
        const changes = settingsChanges(body.values, env);
        const changed = Object.keys(changes);
        if (changed.length === 0) return sendJson(res, 200, { ok: true, changed });

        // Сначала проверка: невалидный конфиг не должен попасть ни в .env, ни в работающего бота.
        try {
          loadConfig({ ...env, ...changes });
        } catch (error) {
          if (error instanceof ConfigError) throw new HttpError(400, error.message);
          throw error;
        }

        writeEnvFile(envPath, changes);
        Object.assign(env, changes);
        console.log(`⚙️  Настройки изменены в панели: ${changed.join(', ')}`);
        await runtime.restart(env);
        return sendJson(res, 200, { ok: true, changed, configError: runtime.configError });
      }

      case 'POST /api/import-env': {
        const body = await readJson(req);
        if (typeof body.content !== 'string' || body.content.trim() === '') {
          throw new HttpError(400, 'Файл пустой');
        }
        const imported = { ...defaults, ...parseEnv(body.content) };

        // Как и при сохранении настроек: невалидный файл не должен затереть рабочий .env.
        try {
          loadConfig(imported);
        } catch (error) {
          if (error instanceof ConfigError) throw new HttpError(400, error.message);
          throw error;
        }

        // Ключи прежнего .env, которых нет в новом, из живого env убираем: иначе они «прилипнут».
        if (existsSync(envPath)) {
          for (const key of Object.keys(parseEnv(readFileSync(envPath, 'utf8')))) delete env[key];
        }
        replaceEnvFile(envPath, body.content);
        Object.assign(env, imported);
        console.log('📥 Настройки импортированы из .env');
        await runtime.restart(env);
        return sendJson(res, 200, { ok: true, configError: runtime.configError });
      }

      case 'GET /api/logs': {
        const after = Number(url.searchParams.get('after') ?? 0) || 0;
        return sendJson(res, 200, { lines: recentLogs(after) });
      }

      default:
        throw new HttpError(404, 'Не найдено');
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const port = (server.address() as AddressInfo).port;
        checkTrusted(req, port);
        await route(req, res, new URL(req.url ?? '/', `http://localhost:${port}`));
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error('❌ Ошибка панели:', errorText(error));
        if (!res.headersSent) sendJson(res, status, { error: errorText(error) });
        else res.end();
      }
    })();
  });

  const panel: Panel = {
    server,
    port: 0,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return panel;
}

function listen(panel: Panel, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    panel.server.once('error', onError);
    panel.server.listen(port, '127.0.0.1', () => {
      panel.server.off('error', onError);
      panel.port = (panel.server.address() as AddressInfo).port;
      resolve();
    });
  });
}

/**
 * Поднимает панель и возвращает её с реальным портом. Занятый порт не роняет бота:
 * без fallback панели просто не будет (undefined), с fallback берём любой свободный.
 */
export async function startPanel(
  deps: PanelDeps,
  port: number,
  options: { fallbackPort?: boolean } = {}
): Promise<Panel | undefined> {
  let panel = createPanel(deps);
  try {
    await listen(panel, port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' && options.fallbackPort && port !== 0) {
      console.warn(`⚠️  Порт ${port} занят, беру свободный`);
      panel = createPanel(deps);
      try {
        await listen(panel, 0);
      } catch (retry) {
        console.error(`❌ Панель не запустилась: ${errorText(retry)}`);
        return undefined;
      }
    } else {
      const reason = code === 'EADDRINUSE' ? `порт ${port} занят — задайте другой в WEB_PORT` : errorText(error);
      console.error(`❌ Панель не запустилась: ${reason}`);
      return undefined;
    }
  }
  console.log(`🌐 Панель: http://localhost:${panel.port}`);
  return panel;
}
