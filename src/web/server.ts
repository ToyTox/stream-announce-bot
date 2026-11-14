import { parse as parseEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as ApiV1 from '../../shared/api-v1.js';
import { channelUrl } from '../announcer.js';
import type { Bot } from '../bot.js';
import { ConfigError, loadConfig, type Env } from '../config.js';
import { openDb, type Db } from '../db.js';
import { DeviceStore, PairingCodes } from '../devices.js';
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
import { StaticLinksError } from '../store.js';
import { TelegramError } from '../telegram/client.js';
import { PLATFORMS, PLATFORM_LABELS } from '../types.js';
import { replaceEnvFile, writeEnvFile } from './envFile.js';
import { pairingQr } from './pairingQr.js';
import { hasSecretKey, settingGuides, settingsChanges, settingsView, settingsViewV1 } from './settings.js';
import { discoverTailscaleAddress, tailscaleAddressAssigned, type TailscaleAddress } from './tailscale.js';

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

interface RemoteListener {
  server: Server;
  node: TailscaleAddress;
  origin: URL;
  controller: AbortController;
  timer?: NodeJS.Timeout;
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
/** Имя устройства при сопряжении: не длиннее. */
const DEVICE_NAME_MAX = 64;
const JSON_LIMIT = 64 * 1024;
/** Лимит Telegram на фото. */
const IMAGE_LIMIT = 10 * 1024 * 1024;
const IMAGE_TYPES: readonly ApiV1.ImageContentType[] = ['image/jpeg', 'image/png', 'image/webp'];
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_KEYS = 4096;
const TAILSCALE_CHECK_MS = 5000;

/** Общее минутное окно; действующие записи не вытесняются при заполнении памяти. */
function rateLimit(max: number): (key: string) => number | undefined {
  const counts = new Map<string, number>();
  let expiresAt = 0;
  return (key) => {
    const now = Date.now();
    if (now >= expiresAt) {
      counts.clear();
      expiresAt = now + RATE_WINDOW_MS;
    }
    const count = counts.get(key) ?? 0;
    if (count >= max || (!counts.has(key) && counts.size >= RATE_MAX_KEYS)) {
      return Math.max(1, Math.ceil((expiresAt - now) / 1000));
    }
    counts.set(key, count + 1);
    return undefined;
  };
}

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

function sendJson<Body>(res: ServerResponse, status: number, body: Body): void {
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

type ParsedJson<Body> = Partial<Record<keyof Body, unknown>>;

async function readJson<Body = Record<string, unknown>>(req: IncomingMessage): Promise<ParsedJson<Body>> {
  const raw = (await readBody(req, JSON_LIMIT)).toString('utf8');
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ParsedJson<Body>) : {};
  } catch {
    throw HttpError.localized(400, 'server.badJson');
  }
}

/**
 * Защита от сайтов, которые попробуют дёрнуть localhost из вашего браузера:
 * чужой Host (DNS rebinding) и чужой Origin отклоняем, а POST принимаем только
 * с JSON — такой запрос браузер не отправит на другой сайт без разрешения CORS.
 */
function checkTrusted(req: IncomingMessage, allowedHosts: string[]): void {
  const host = req.headers.host ?? '';
  if (!allowedHosts.includes(host)) throw HttpError.localized(403, 'server.forbiddenHost');

  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.some((allowed) => origin === `http://${allowed}`)) {
    throw HttpError.localized(403, 'server.forbiddenOrigin');
  }
}

/** Токен из заголовка Authorization: undefined, если заголовка нет; пустая строка, если он не Bearer. */
function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

/** Запрос пришёл с этого же компьютера. */
function isLocalRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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

export function createPanel(deps: PanelDeps): Panel & { startRemote(): Promise<void> } {
  const { runtime, env, envPath, defaults = {}, version = '' } = deps;
  let remote: RemoteListener | undefined;
  let remoteClosed: Promise<void> | undefined;

  function stopRemote(reason?: string): void {
    if (!remote) return;
    const { server, controller, timer } = remote;
    remote = undefined;
    controller.abort();
    clearTimeout(timer);
    remoteClosed = closeServer(server);
    if (reason) console.warn(`⚠️ Удалённый API через Tailscale остановлен: ${reason}`);
  }

  function activeRemote(): RemoteListener | undefined {
    if (remote && (!remote.server.listening || !tailscaleAddressAssigned(remote.node))) {
      stopRemote('локальный адрес Tailscale больше не подтверждён');
    }
    return remote;
  }

  function scheduleRemoteCheck(listener: RemoteListener): void {
    listener.timer = setTimeout(async () => {
      try {
        const node = await discoverTailscaleAddress(listener.controller.signal);
        if (remote !== listener) return;
        if (node.address !== listener.node.address || node.interfaceName !== listener.node.interfaceName) {
          stopRemote('локальный адрес Tailscale изменился');
          return;
        }
        scheduleRemoteCheck(listener);
      } catch (error) {
        if (remote === listener) stopRemote(errorText(error));
      }
    }, TAILSCALE_CHECK_MS).unref();
  }

  function pairingApiUrl(): string | undefined {
    const listener = activeRemote();
    return listener && `${listener.origin.origin}/api/v1`;
  }

  // Реестр устройств живёт в той же базе, что и бот, но открывается отдельным соединением:
  // бот может быть не запущен (ошибка конфигурации) или перезапускаться через runtime.restart.
  let devicesDb: { path: string; db: Db } | undefined;

  function devices(): DeviceStore | undefined {
    const path = env.DATABASE_PATH?.trim() || defaults.DATABASE_PATH?.trim() || './data/bot.db';
    if (devicesDb?.path !== path) {
      devicesDb?.db.close();
      devicesDb = undefined;
      try {
        devicesDb = { path, db: openDb(path) };
      } catch (error) {
        console.error('❌ Не удалось открыть реестр устройств:', errorText(error));
        return undefined;
      }
    }
    return new DeviceStore(devicesDb.db);
  }

  // Коды сопряжения только в памяти: перезапуск их аннулирует.
  const pairing = new PairingCodes();
  const deviceRate = rateLimit(120);
  const addressRate = rateLimit(60);
  const pairingRate = rateLimit(10);

  /** Без Bearer разрешены только локальные запросы к панели. */
  function checkBearer(req: IncomingMessage, remoteRequest: boolean): { store: DeviceStore; id: number; key: string } | undefined {
    const token = bearerToken(req);
    if (token === undefined) {
      if (!remoteRequest && isLocalRequest(req)) return;
      throw HttpError.localized(401, 'server.unauthorized');
    }
    const store = devices();
    const device = store?.findByToken(token);
    if (!store || !device) throw HttpError.localized(401, 'server.unauthorized');
    return { store, id: device.id, key: `${devicesDb!.path}:${device.id}` };
  }

  function status(lang: Lang): ApiV1.StatusResponse {
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

  /** Общая часть PUT настроек: проверка, запись в .env, перезапуск бота. */
  async function saveSettings(values: unknown, lang: Lang, source: string): Promise<ApiV1.SettingsWriteResult> {
    const changes = settingsChanges(values, env);
    const [first, ...rest] = Object.keys(changes);
    if (first === undefined) return { ok: true, changed: [] };
    const changed: [string, ...string[]] = [first, ...rest];

    // Сначала проверка: невалидный конфиг не должен попасть ни в .env, ни в работающего бота.
    try {
      loadConfig({ ...env, ...changes });
    } catch (error) {
      if (error instanceof ConfigError) throw new HttpError(400, error.localize(lang));
      throw error;
    }

    writeEnvFile(envPath, changes);
    Object.assign(env, changes);
    console.log(`⚙️  Настройки изменены ${source}: ${changed.join(', ')}`);
    await runtime.restart(env);
    return { ok: true, changed, configError: configErrorText(runtime, lang) };
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, lang: Lang, remoteRequest: boolean): Promise<void> {
    const key = `${req.method} ${url.pathname}`;
    const needBot = () => requireBot(runtime, lang);
    const recheckRemoteBearer = () => {
      if (remoteRequest) checkBearer(req, true);
    };

    switch (key) {
      case 'GET /':
      case 'GET /index.html': {
        const html = await readFile(INDEX_HTML);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      case 'POST /api/pairing': {
        const apiUrl = pairingApiUrl();
        if (url.searchParams.get('qr') === 'true' && !apiUrl) return sendJson(res, 200, {});
        if (!devices()) throw HttpError.localized(503, 'server.pairing.noRegistry');
        const issued = pairing.issue();
        const qrDataUrl = await pairingQr(apiUrl, issued);
        return sendJson(res, 200, { ...issued, ...(qrDataUrl && pairingApiUrl() === apiUrl ? { apiUrl, qrDataUrl } : {}) });
      }

      case 'GET /api/pairing':
        return sendJson(res, 200, { available: pairingApiUrl() !== undefined });

      case 'GET /api/devices': {
        try {
          const store = devices();
          if (!store) throw new Error();
          return sendJson(res, 200, { devices: store.list() });
        } catch {
          throw HttpError.localized(503, 'server.pairing.noRegistry');
        }
      }

      case 'POST /api/devices/revoke': {
        const body = await readJson(req);
        if (typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id <= 0) {
          throw HttpError.localized(400, 'server.devices.badId');
        }
        let revoked: boolean;
        try {
          const store = devices();
          if (!store) throw new Error();
          revoked = store.revoke(body.id);
        } catch {
          throw HttpError.localized(503, 'server.pairing.noRegistry');
        }
        if (!revoked) throw HttpError.localized(404, 'server.devices.notActive');
        return sendJson(res, 200, { ok: true });
      }

      case 'POST /api/v1/pair': {
        const body = await readJson<ApiV1.PairingRequest>(req);
        if (typeof body.code !== 'string' || typeof body.name !== 'string') throw HttpError.localized(400, 'server.pairing.badBody');
        const name = body.name.trim();
        if (name === '') throw HttpError.localized(400, 'server.pairing.emptyName');
        if (name.length > DEVICE_NAME_MAX) throw HttpError.localized(400, 'server.pairing.longName', { max: DEVICE_NAME_MAX });
        const store = devices();
        if (!store) throw HttpError.localized(503, 'server.pairing.noRegistry');
        // Неверный, просроченный и уже использованный код неразличимы в ответе.
        if (!pairing.redeem(body.code)) throw HttpError.localized(401, 'server.pairing.badCode');
        return sendJson<ApiV1.PairingResult>(res, 200, store.issue(name));
      }

      case 'GET /api/v1/info':
        return sendJson<ApiV1.InfoResponse>(res, 200, { apiVersion: API_VERSION, version });

      case 'GET /api/status':
      case 'GET /api/v1/status':
        return sendJson(res, 200, status(lang));

      case 'POST /api/probe':
      case 'POST /api/v1/probe':
        await needBot().tickNow();
        return sendJson(res, 200, status(lang));

      case 'POST /api/test-message':
      case 'POST /api/v1/test-message': {
        const bot = needBot();
        const text = t(lang, 'server.testMessage');
        const sendTest = async (
          target: ApiV1.TestMessageTarget,
          send: () => Promise<unknown>
        ): Promise<ApiV1.TestMessageDelivery> => {
          try {
            await send();
            return { ...target, ok: true };
          } catch (error) {
            return { ...target, ok: false, error: errorText(error) };
          }
        };

        // Площадки независимы: сбой одной не скрывает успех другой.
        const { telegram, discord } = bot;
        const [telegramResult, discordResult] = await Promise.all([
          telegram && sendTest({ channel: 'telegram', label: 'Telegram' }, () => telegram.sendMessage(text)),
          discord && sendTest({ channel: 'discord', label: 'Discord' }, () => discord.send({ embeds: [{ description: text }] })),
        ]);

        let result: ApiV1.TestMessageResult;
        if (telegramResult?.ok === false) {
          result = { ok: false, results: discordResult ? [telegramResult, discordResult] : [telegramResult] };
        } else if (discordResult?.ok === false) {
          result = { ok: false, results: telegramResult ? [telegramResult, discordResult] : [discordResult] };
        } else if (telegramResult && discordResult) {
          result = { ok: true, results: [telegramResult, discordResult] };
        } else {
          const delivered = telegramResult ?? discordResult;
          result = { ok: true, results: delivered ? [delivered] : [] };
        }
        return sendJson(res, 200, result);
      }

      case 'POST /api/test-announce/telegram':
      case 'POST /api/v1/test-announce/telegram':
      case 'POST /api/test-announce/discord':
      case 'POST /api/v1/test-announce/discord': {
        const bot = needBot();
        const channel = url.pathname.endsWith('/discord') ? 'discord' : 'telegram';
        if (channel === 'telegram' && !bot.telegram) throw HttpError.localized(400, 'server.telegramNotConfigured');
        if (channel === 'discord' && !bot.config.discord) throw HttpError.localized(400, 'server.discordNotConfigured');
        try {
          await bot.announcer.testAnnounce(channel);
        } catch (error) {
          throw new HttpError(502, errorText(error));
        }
        return sendJson<ApiV1.OkResponse>(res, 200, { ok: true });
      }

      case 'GET /api/text':
      case 'GET /api/v1/text':
        return sendJson<ApiV1.TextResponse>(res, 200, { text: needBot().store.announceText() });

      case 'PUT /api/text':
      case 'PUT /api/v1/text': {
        const store = needBot().store;
        const body = await readJson<ApiV1.TextWriteRequest>(req);
        recheckRemoteBearer();
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (text) store.setAnnounceText(text);
        else store.clearAnnounceText();
        return sendJson<ApiV1.TextResponse>(res, 200, { text: store.announceText() });
      }

      case 'GET /api/links':
      case 'GET /api/v1/links':
        return sendJson<ApiV1.LinksResponse>(res, 200, { links: needBot().store.staticLinks() });

      case 'PUT /api/links':
      case 'PUT /api/v1/links': {
        const store = needBot().store;
        const body = await readJson<ApiV1.LinksWriteRequest>(req);
        recheckRemoteBearer();
        try {
          return sendJson<ApiV1.LinksResponse>(res, 200, { links: store.setStaticLinks(body.links) });
        } catch (error) {
          if (error instanceof StaticLinksError) throw HttpError.localized(400, error.key, error.params);
          throw error;
        }
      }

      case 'DELETE /api/text':
      case 'DELETE /api/v1/text':
        needBot().store.clearAnnounceText();
        return sendJson<ApiV1.TextDeleteResponse>(res, 200, { text: null });

      case 'PUT /api/image':
      case 'PUT /api/v1/image': {
        const bot = needBot();
        const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
        const type = IMAGE_TYPES.find((allowed) => allowed === contentType);
        if (type === undefined) throw HttpError.localized(415, 'server.imageTypes');

        const data: ApiV1.ImageFile['data'] = await readBody(req, IMAGE_LIMIT);
        recheckRemoteBearer();

        // Загрузка в личку нужна, только чтобы получить file_id; без Telegram или админа картинка живёт локально.
        const adminId = bot.config.telegram?.adminId;
        if (!bot.telegram || adminId === undefined) {
          bot.image.setLocal({ data, type });
          return sendJson<ApiV1.OkResponse>(res, 200, { ok: true });
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
        return sendJson<ApiV1.OkResponse>(res, 200, { ok: true });
      }

      case 'GET /api/image/file':
      case 'GET /api/v1/image/file': {
        const bot = needBot();
        if (!bot.store.announcePhoto()) throw HttpError.localized(404, 'server.noImage');
        // Копия на диске; если её нет, load() один раз скачает файл из Telegram (без Telegram — null).
        let image: ApiV1.ImageFile<string> | null;
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
      case 'DELETE /api/v1/image':
        needBot().image.clear();
        return sendJson<ApiV1.OkResponse>(res, 200, { ok: true });

      case 'GET /api/preview':
      case 'GET /api/v1/preview': {
        const bot = needBot();
        return sendJson<ApiV1.PreviewResponse>(res, 200, {
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

      case 'GET /api/v1/settings':
        return sendJson<ApiV1.SettingsResponse>(res, 200, {
          fields: settingsViewV1(env, lang),
          configError: configErrorText(runtime, lang),
        });

      case 'PUT /api/settings': {
        const body = await readJson(req);
        return sendJson(res, 200, await saveSettings(body.values, lang, 'в панели'));
      }

      case 'PUT /api/v1/settings': {
        const body = await readJson<ApiV1.SettingsWriteRequest>(req);
        recheckRemoteBearer();
        if (hasSecretKey(body.values)) throw HttpError.localized(400, 'server.secretsViaApi');
        return sendJson(res, 200, await saveSettings(body.values, lang, 'через API'));
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
        const after: ApiV1.LogsQuery['after'] = Number(url.searchParams.get('after') ?? 0) || 0;
        return sendJson<ApiV1.LogsResponse>(res, 200, { lines: recentLogs(after) });
      }

      default:
        throw HttpError.localized(404, 'server.notFound');
    }
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse, server: Server, remoteRequest = false): void {
    void (async () => {
      const lang = requestLanguage(req, env);
      try {
        const target = req.url ?? '/';
        let url: URL;
        if (remoteRequest) {
          const listener = activeRemote();
          if (listener?.server !== server) return;
          const { origin } = listener;
          if (req.headersDistinct.host?.length !== 1) throw HttpError.localized(403, 'server.forbiddenHost');
          checkTrusted(req, origin.port ? [origin.host] : [origin.host, `${origin.host}:80`]);
          const rawPath = target.split('?', 1)[0]!;
          if (!/^\/api\/v1(?:\/[A-Za-z0-9_-]+)*\/?$/.test(rawPath) || target.includes('#') ||
              (req.method === 'POST' && rawPath === '/api/v1/pair' && target !== rawPath)) {
            throw HttpError.localized(404, 'server.notFound');
          }
          url = new URL(target, origin);
          if (url.pathname !== rawPath || url.origin !== origin.origin) throw HttpError.localized(404, 'server.notFound');
        } else {
          const port = (server.address() as AddressInfo).port;
          checkTrusted(req, [`localhost:${port}`, `127.0.0.1:${port}`]);
          url = new URL(target, `http://localhost:${port}`);
        }
        if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
          const address = req.socket.remoteAddress ?? '';
          let retryAfter: number | undefined;
          let identity: ReturnType<typeof checkBearer>;
          let authError: unknown;
          if (req.method === 'POST' && url.pathname === '/api/v1/pair') {
            retryAfter = pairingRate(address);
          } else {
            try {
              identity = checkBearer(req, remoteRequest);
            } catch (error) {
              authError = error;
            }
            retryAfter = identity ? deviceRate(identity.key) : addressRate(address);
          }
          if (retryAfter !== undefined) {
            res.setHeader('Retry-After', retryAfter);
            throw HttpError.localized(429, 'server.rateLimit');
          }
          if (authError) throw authError;
          identity?.store.touch(identity.id);
        }
        const type = req.headers['content-type'] ?? '';
        if (req.method === 'POST' && !type.startsWith('application/json')) {
          throw HttpError.localized(415, 'server.jsonExpected');
        }
        await route(req, res, url, lang, remoteRequest);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error('❌ Ошибка панели:', errorText(error));
        const message = error instanceof HttpError && error.key ? t(lang, error.key, error.params) : errorText(error);
        if (!res.headersSent) sendJson<ApiV1.ErrorResponse>(res, status, { error: message });
        else res.end();
      }
    })();
  }

  const server = createServer((req, res) => handleRequest(req, res, server));
  const panel = {
    server,
    port: 0,
    async startRemote() {
      let node: TailscaleAddress;
      try {
        node = await discoverTailscaleAddress();
      } catch (error) {
        console.warn(`⚠️ Удалённый API через Tailscale недоступен: ${errorText(error)}`);
        return;
      }

      const origin = new URL(`http://${node.address}:${panel.port}`);
      const api = createServer((req, res) => handleRequest(req, res, api, true));
      try {
        await listen(api, panel.port, node.address);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        console.warn(`⚠️ Не удалось открыть удалённый API через Tailscale на порту ${panel.port}${code ? ` (${code})` : ''}`);
        return;
      }

      api.on('error', () => stopRemote('ошибка слушателя'));
      remote = { server: api, node, origin, controller: new AbortController() };
      const listener = activeRemote();
      if (listener) {
        scheduleRemoteCheck(listener);
        console.log(`🌐 Удалённый API через Tailscale: ${origin.origin}/api/v1`);
      }
    },
    async close() {
      stopRemote();
      await Promise.all([closeServer(server), remoteClosed]);
      devicesDb?.db.close();
      devicesDb = undefined;
    },
  };
  return panel;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
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
  options: { fallbackPort?: boolean; remoteEnabled?: boolean } = {}
): Promise<Panel | undefined> {
  let panel = createPanel(deps);
  try {
    panel.port = await listen(panel.server, port, '127.0.0.1');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' && options.fallbackPort && port !== 0) {
      console.warn(`⚠️  Порт ${port} занят, беру свободный`);
      panel = createPanel(deps);
      try {
        panel.port = await listen(panel.server, 0, '127.0.0.1');
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
  if (options.remoteEnabled) await panel.startRemote();
  return panel;
}
