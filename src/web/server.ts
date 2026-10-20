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
import {
  announceLanguageFromEnv,
  languageFromEnv,
  languageOptions,
  messagesFor,
  normalizeLanguage,
  resolveLanguage,
  t,
  type Lang,
  type Params,
} from '../i18n/index.js';
import { recentLogs } from '../log.js';
import { TelegramError } from '../telegram/client.js';
import { PLATFORMS, PLATFORM_LABELS } from '../types.js';
import { replaceEnvFile, writeEnvFile } from './envFile.js';
import { settingGuides, settingsChanges, settingsView } from './settings.js';

/**
 * Локальная панель: настройки, статус, превью сообщений и лог. Слушает только
 * 127.0.0.1 и отвечает только на Host localhost — из сети и с чужих сайтов недоступна.
 */

export interface PanelRuntime {
  bot: Bot | null;
  configError: string | null;
  /** Та же ошибка с ключом словаря: даёт показать её на языке панели. */
  configErrorSource?: ConfigError | null;
  restart(env: Env): Promise<void>;
}

export interface PanelDeps {
  runtime: PanelRuntime;
  /** Живой env процесса: после сохранения настроек обновляется вместе с .env. */
  env: Env;
  envPath: string;
  /** Значения, которых нет в .env, но нужны боту (например, путь к базе в десктопном приложении). */
  defaults?: Env;
  /** Версия приложения для шапки панели. */
  version?: string;
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
/** Версия контракта /api/v1: растёт только при несовместимых изменениях. */
const API_VERSION = 1;
const JSON_LIMIT = 64 * 1024;
/** Лимит Telegram на фото. */
const IMAGE_LIMIT = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Ключ словаря: текст подставляется на языке запроса при отправке ответа. */
    readonly key?: string,
    readonly params?: Params
  ) {
    super(message);
  }

  static localized(status: number, key: string, params?: Params): HttpError {
    return new HttpError(status, t('ru', key, params), key, params);
  }
}

/** Язык запроса: APP_LANGUAGE, иначе язык браузера из Accept-Language. */
function requestLanguage(req: IncomingMessage, env: Env): Lang {
  const header = req.headers['accept-language'];
  const locale = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.split(';')[0]?.trim();
  return resolveLanguage(env.APP_LANGUAGE, locale);
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
    if (size > limit) throw HttpError.localized(413, 'server.tooLarge', { mb: Math.round(limit / 1024 / 1024) });
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
    throw HttpError.localized(400, 'server.badJson');
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
  if (!allowedHosts.includes(host)) throw HttpError.localized(403, 'server.forbiddenHost');

  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.some((allowed) => origin === `http://${allowed}`)) {
    throw HttpError.localized(403, 'server.forbiddenOrigin');
  }

  const type = req.headers['content-type'] ?? '';
  if (req.method === 'POST' && !type.startsWith('application/json')) {
    throw HttpError.localized(415, 'server.jsonExpected');
  }
}

/** Причина, по которой бот не запущен, на языке lang. */
function configErrorText(runtime: PanelRuntime, lang: Lang): string | null {
  return runtime.configErrorSource?.localize(lang) ?? runtime.configError;
}

function requireBot(runtime: PanelRuntime, lang: Lang): Bot {
  if (runtime.bot) return runtime.bot;
  const reason = configErrorText(runtime, lang);
  throw reason ? HttpError.localized(503, 'server.botDownReason', { reason }) : HttpError.localized(503, 'server.botDown');
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
  const { runtime, env, envPath, defaults = {}, version = '' } = deps;

  function status(lang: Lang) {
    const bot = runtime.bot;
    if (!bot) return { version, running: false, configError: configErrorText(runtime, lang) };

    const broadcast = bot.announcer.status();
    const states = new Map(bot.announcer.platformStates().map((state) => [state.platform, state]));
    return {
      version,
      running: true,
      configError: null,
      dryRun: bot.config.dryRun,
      telegramSet: bot.telegram !== undefined,
      adminSet: bot.config.telegram?.adminId !== undefined,
      discordSet: bot.config.discord !== undefined,
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
      hasImage: bot.image.has(),
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, lang: Lang): Promise<void> {
    const key = `${req.method} ${url.pathname}`;
    const needBot = () => requireBot(runtime, lang);

    switch (key) {
      case 'GET /':
      case 'GET /index.html': {
        const html = await readFile(INDEX_HTML);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      case 'GET /api/v1/info':
        return sendJson(res, 200, { apiVersion: API_VERSION, version });

      case 'GET /api/status':
      case 'GET /api/v1/status':
        return sendJson(res, 200, status(lang));

      case 'POST /api/probe':
        await needBot().tickNow();
        return sendJson(res, 200, status(lang));

      case 'POST /api/test-message': {
        const bot = needBot();
        const text = t(lang, 'server.testMessage');
        const targets = [
          ...(bot.telegram ? [{ channel: 'telegram', label: 'Telegram', send: () => bot.telegram!.sendMessage(text) }] : []),
          ...(bot.discord
            ? [{ channel: 'discord', label: 'Discord', send: () => bot.discord!.send({ embeds: [{ description: text }] }) }]
            : []),
        ];
        // Площадки независимы: сбой одной не скрывает успех другой.
        const results = await Promise.all(
          targets.map(async ({ channel, label, send }) => {
            try {
              await send();
              return { channel, label, ok: true };
            } catch (error) {
              return { channel, label, ok: false, error: errorText(error) };
            }
          })
        );
        return sendJson(res, 200, { ok: results.every((result) => result.ok), results });
      }

      case 'POST /api/test-announce/telegram':
      case 'POST /api/test-announce/discord': {
        const bot = needBot();
        const channel = url.pathname.endsWith('/discord') ? 'discord' : 'telegram';
        if (channel === 'telegram' && !bot.telegram) throw HttpError.localized(400, 'server.telegramNotConfigured');
        if (channel === 'discord' && !bot.config.discord) throw HttpError.localized(400, 'server.discordNotConfigured');
        try {
          await bot.announcer.testAnnounce(channel);
        } catch (error) {
          throw new HttpError(502, errorText(error));
        }
        return sendJson(res, 200, { ok: true });
      }

      case 'GET /api/text':
        return sendJson(res, 200, { text: needBot().store.announceText() });

      case 'PUT /api/text': {
        const store = needBot().store;
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (text) store.setAnnounceText(text);
        else store.clearAnnounceText();
        return sendJson(res, 200, { text: store.announceText() });
      }

      case 'DELETE /api/text':
        needBot().store.clearAnnounceText();
        return sendJson(res, 200, { text: null });

      case 'PUT /api/image': {
        const bot = needBot();
        const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
        if (!IMAGE_TYPES.has(type)) throw HttpError.localized(415, 'server.imageTypes');

        const data = await readBody(req, IMAGE_LIMIT);

        // Загрузка в личку нужна, только чтобы получить file_id; без Telegram или админа картинка живёт локально.
        const adminId = bot.config.telegram?.adminId;
        if (!bot.telegram || adminId === undefined) {
          bot.image.setLocal({ data, type });
          return sendJson(res, 200, { ok: true });
        }

        let fileId: string | undefined;
        try {
          const message = await bot.telegram.uploadPhoto(adminId, data, type, t(lang, 'server.imageCaption'));
          fileId = message.photo?.at(-1)?.file_id;
        } catch (error) {
          const hint =
            error instanceof TelegramError && error.code === 'chat_not_found'
              ? t(lang, 'server.imageChatHint')
              : '';
          throw new HttpError(502, `${errorText(error)}${hint}`);
        }
        if (!fileId) throw HttpError.localized(502, 'server.noFileId');

        bot.image.set(fileId, { data, type });
        return sendJson(res, 200, { ok: true });
      }

      case 'GET /api/image/file': {
        const bot = needBot();
        if (!bot.store.announcePhoto()) throw HttpError.localized(404, 'server.noImage');
        // Копия на диске; если её нет, load() один раз скачает файл из Telegram (без Telegram — null).
        let image: Awaited<ReturnType<typeof bot.image.load>>;
        try {
          image = await bot.image.load();
        } catch (error) {
          throw new HttpError(502, errorText(error));
        }
        if (!image) throw HttpError.localized(404, 'server.noImage');
        res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'no-store' });
        res.end(image.data);
        return;
      }

      case 'DELETE /api/image':
        needBot().image.clear();
        return sendJson(res, 200, { ok: true });

      case 'GET /api/preview': {
        const bot = needBot();
        return sendJson(res, 200, {
          ...bot.announcer.preview(),
          photo: bot.image.has() ? 'custom' : 'twitch',
        });
      }

      case 'GET /api/settings':
        return sendJson(res, 200, {
          fields: settingsView(env, lang),
          guides: settingGuides(lang),
          configError: configErrorText(runtime, lang),
        });

      case 'PUT /api/settings': {
        const body = await readJson(req);
        const changes = settingsChanges(body.values, env);
        const changed = Object.keys(changes);
        if (changed.length === 0) return sendJson(res, 200, { ok: true, changed });

        // Сначала проверка: невалидный конфиг не должен попасть ни в .env, ни в работающего бота.
        try {
          loadConfig({ ...env, ...changes });
        } catch (error) {
          if (error instanceof ConfigError) throw new HttpError(400, error.localize(lang));
          throw error;
        }

        writeEnvFile(envPath, changes);
        Object.assign(env, changes);
        console.log(`⚙️  Настройки изменены в панели: ${changed.join(', ')}`);
        await runtime.restart(env);
        return sendJson(res, 200, { ok: true, changed, configError: configErrorText(runtime, lang) });
      }

      case 'POST /api/import-env': {
        const body = await readJson(req);
        if (typeof body.content !== 'string' || body.content.trim() === '') {
          throw HttpError.localized(400, 'server.fileEmpty');
        }
        const imported = { ...defaults, ...parseEnv(body.content) };

        // Как и при сохранении настроек: невалидный файл не должен затереть рабочий .env.
        try {
          loadConfig(imported);
        } catch (error) {
          if (error instanceof ConfigError) throw new HttpError(400, error.localize(lang));
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
        return sendJson(res, 200, { ok: true, configError: configErrorText(runtime, lang) });
      }

      case 'GET /api/i18n':
        return sendJson(res, 200, {
          language: lang,
          // Явный выбор (пусто — авто): по нему переключатель в шапке показывает «авто».
          setting: normalizeLanguage(env.APP_LANGUAGE) ?? '',
          languages: languageOptions(),
          messages: messagesFor(lang),
        });

      // Язык меняется без перезапуска бота: он читает язык из своего конфига при каждом сообщении.
      case 'PUT /api/language': {
        const body = await readJson(req);
        const value = typeof body.language === 'string' ? body.language.trim().toLowerCase() : '';
        if (value !== '' && !normalizeLanguage(value)) throw HttpError.localized(400, 'server.badLanguage');
        writeEnvFile(envPath, { APP_LANGUAGE: value });
        env.APP_LANGUAGE = value;
        if (runtime.bot) {
          runtime.bot.config.language = languageFromEnv(env);
          runtime.bot.config.announceLanguage = announceLanguageFromEnv(env);
        }
        return sendJson(res, 200, { ok: true });
      }

      case 'GET /api/logs':
      case 'GET /api/v1/logs': {
        const after = Number(url.searchParams.get('after') ?? 0) || 0;
        return sendJson(res, 200, { lines: recentLogs(after) });
      }

      default:
        throw HttpError.localized(404, 'server.notFound');
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const lang = requestLanguage(req, env);
      try {
        const port = (server.address() as AddressInfo).port;
        checkTrusted(req, port);
        await route(req, res, new URL(req.url ?? '/', `http://localhost:${port}`), lang);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error('❌ Ошибка панели:', errorText(error));
        const message = error instanceof HttpError && error.key ? t(lang, error.key, error.params) : errorText(error);
        if (!res.headersSent) sendJson(res, status, { error: message });
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
