import {
  renderAnnounce,
  renderDiscordAnnounce,
  renderDiscordFinished,
  renderFinished,
  AnnounceInput,
  ChannelLink,
  FinishedInput,
} from './announceTemplate.js';
import axios from 'axios';
import type { AnnounceImage } from './announceImage.js';
import type { Config } from './config.js';
import { DiscordClient, DiscordError, type DiscordFile } from './discord/client.js';
import { t } from './i18n/index.js';
import { Store, type DeliveryRow } from './store.js';
import { TelegramClient, TelegramError, type SendOptions } from './telegram/client.js';
import { LiveStream, PLATFORMS, PLATFORM_LABELS, Platform } from './types.js';
import type { BaseWatcher } from './watchers/base.js';
import { CHANNEL_BASE as VK_LIVE_BASE } from './watchers/vkvideo.js';

/**
 * Оркестратор. Сущность здесь — не «стрим на платформе», а эфир: OBS поднимает
 * все площадки разом, поэтому сообщение всегда одно, а ссылки в нём — только на те
 * платформы, которые действительно в эфире.
 */

/** События для оболочек вроде десктопного приложения; на логику анонсов не влияют. */
export type AnnouncerEvent =
  | { type: 'announced'; platforms: string[] }
  | { type: 'finished'; durationMs: number }
  /** channel — площадка, которая не получила анонс (например, «Discord»). */
  | { type: 'announce_failed'; channel: string; error: string };

export interface AnnouncerDeps {
  store: Store;
  watchers: BaseWatcher[];
  /** Есть только при включённом Telegram. */
  telegram?: TelegramClient;
  /** Есть только при заданном DISCORD_WEBHOOK_URL. */
  discord?: DiscordClient;
  /** Своя картинка: Discord получает её файлом, Telegram — по file_id или файлом. */
  image: AnnounceImage;
  config: Config;
  /** Подменяется в тестах, чтобы гонять grace-периоды без ожидания. */
  now?: () => number;
  onEvent?: (event: AnnouncerEvent) => void;
}

/** Итог последней проверки площадки — для панели. */
export interface PlatformState {
  platform: Platform;
  state: 'live' | 'offline' | 'error';
  error?: string;
  checkedAt: number;
}

export interface BroadcastStatus {
  startedAt: number;
  announcedAt: number | null;
  chatId: string | null;
  messageId: number | null;
  platforms: Platform[];
  /** Состояние доставки по площадкам (Telegram, Discord). */
  deliveries: Array<{ channel: string; label: string; state: DeliveryRow['state'] }>;
}

/** Что нужно площадке, чтобы собрать анонс: Telegram и Discord берут картинку по-разному. */
interface AnnounceRequest {
  input: AnnounceInput;
  /** Своя картинка из /image или панели: метка в базе (file_id Telegram или локальная). */
  customPhoto: string | null;
  /** Превью приоритетной площадки — обычный URL, годится всем. */
  thumbnailUrl?: string | null;
  /** Платформа, с которой взято превью: Discord берёт только превью Twitch. */
  thumbnailPlatform?: Platform;
  /** Telegram: отправить без звука уведомления (тестовый анонс). */
  silent?: boolean;
}

/** Типы, которые Discord показывает в embed. */
const DISCORD_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
/** Лимит Discord на файл по умолчанию — 20 MiB; берём с запасом на остальное тело запроса. */
const DISCORD_IMAGE_LIMIT = 10 * 1024 * 1024;
const THUMBNAIL_TIMEOUT = 10_000;

/** Куда ушло сообщение: id сообщения и, если есть, адресат (чат). */
interface Sent {
  messageId: string | null;
  target: string | null;
}

interface Prepared<T> {
  /** Итоговый текст — для лога в DRY_RUN. */
  text: string;
  send(): Promise<T>;
}

/**
 * Площадка доставки. Announcer не знает, какая она: у всех одинаковый путь —
 * подготовить сообщение, отправить, записать результат по своей площадке.
 */
interface DeliveryChannel {
  /** Ключ в базе. */
  id: string;
  label: string;
  /** Постоянная ошибка: повторять бессмысленно. */
  isPermanent(error: unknown): boolean;
  /** Постоянная ошибка останавливает проверку (неверная настройка, которую надо чинить), а не только эту площадку. */
  throwOnPermanent: boolean;
  prepareAnnounce(request: AnnounceRequest): Prepared<Sent>;
  prepareFinished(input: FinishedInput): Prepared<void>;
}

class TelegramChannel implements DeliveryChannel {
  readonly id = 'telegram';
  readonly label = 'Telegram';
  readonly throwOnPermanent = true;

  constructor(
    private readonly client: TelegramClient,
    private readonly chatId: string,
    private readonly image: AnnounceImage
  ) {}

  isPermanent(error: unknown): boolean {
    return error instanceof TelegramError && !error.retriable;
  }

  prepareAnnounce({ input, customPhoto, thumbnailUrl, silent }: AnnounceRequest): Prepared<Sent> {
    const text = renderAnnounce(input);
    // Своя картинка важнее превью Twitch; живёт, пока её не сбросят через /image - или в панели.
    const options = silent ? { silent } : undefined;
    return {
      text,
      send: async () => {
        const message = await this.sendAnnounce(customPhoto, thumbnailUrl, text, options);
        return { messageId: String(message.message_id), target: this.chatId };
      },
    };
  }

  prepareFinished(input: FinishedInput): Prepared<void> {
    const text = renderFinished(input);
    return {
      text,
      send: async () => {
        await this.client.sendMessage(text);
      },
    };
  }

  private async sendAnnounce(
    customPhoto: string | null,
    thumbnailUrl: string | null | undefined,
    text: string,
    options?: SendOptions
  ) {
    if (customPhoto) {
      const fileId = this.image.telegramFileId();
      if (fileId) return this.sendWithPhotoFallback(fileId, text, options);
      // Картинка только на диске: отправляем файл. Нет копии — как будто своей картинки нет.
      const stored = this.image.read();
      if (stored) {
        try {
          return await this.client.sendPhotoFile(stored.data, stored.type, text, options);
        } catch (error) {
          if (error instanceof TelegramError && error.code === 'upstream') {
            console.warn('⚠️  Картинка не ушла, отправляю текстом:', error.message);
            return this.client.sendMessage(text, options);
          }
          throw error;
        }
      }
    }
    return thumbnailUrl
      ? this.sendWithPhotoFallback(thumbnailUrl, text, options)
      : this.client.sendMessage(text, options);
  }

  /** Превью может не подгрузиться на стороне Telegram — тогда шлём текстом. */
  private async sendWithPhotoFallback(photo: string, caption: string, options?: SendOptions) {
    try {
      return await this.client.sendPhoto(photo, caption, options);
    } catch (error) {
      if (error instanceof TelegramError && error.code === 'upstream') {
        console.warn('⚠️  Превью не ушло, отправляю текстом:', error.message);
        return this.client.sendMessage(caption, options);
      }
      throw error;
    }
  }
}

class DiscordChannel implements DeliveryChannel {
  readonly id = 'discord';
  readonly label = 'Discord';
  readonly throwOnPermanent = false;

  constructor(
    private readonly client: DiscordClient,
    private readonly image: AnnounceImage
  ) {}

  isPermanent(error: unknown): boolean {
    return error instanceof DiscordError && !error.retriable;
  }

  prepareAnnounce(request: AnnounceRequest): Prepared<Sent> {
    const text = renderDiscordAnnounce(request.input);
    return {
      text,
      send: async () => {
        // Картинку грузим только перед отправкой: в DRY_RUN сюда не доходим.
        const file = await this.pickImage(request);
        const message = await this.client.send(
          {
            embeds: [{ description: text, ...(file ? { image: { url: `attachment://${file.name}` } } : {}) }],
          },
          file
        );
        return { messageId: message.id, target: null };
      },
    };
  }

  /**
   * Своя картинка, иначе превью Twitch (только если приоритетная площадка — Twitch), иначе без картинки.
   * Сбой загрузки не мешает анонсу: он уходит без картинки.
   */
  private async pickImage({ customPhoto, thumbnailUrl, thumbnailPlatform }: AnnounceRequest): Promise<DiscordFile | undefined> {
    if (customPhoto) {
      // Свою картинку на превью Twitch не подменяем: покажет не то, что выбрал стример.
      try {
        const stored = await this.image.load();
        // Картинки нет совсем (нет копии и Telegram): молча берём превью площадки.
        if (stored) return toDiscordFile('announce', stored.type, stored.data);
      } catch (error) {
        console.warn('⚠️  Своя картинка недоступна, Discord получит анонс без картинки:', describe(error));
        return undefined;
      }
    }
    if (thumbnailPlatform !== 'twitch' || !thumbnailUrl || !/^https?:\/\//i.test(thumbnailUrl)) return undefined;
    try {
      const response = await axios.get<ArrayBuffer>(thumbnailUrl, {
        responseType: 'arraybuffer',
        timeout: THUMBNAIL_TIMEOUT,
        maxContentLength: DISCORD_IMAGE_LIMIT,
      });
      const type = String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      return toDiscordFile('preview', type, new Uint8Array(response.data));
    } catch (error) {
      console.warn('⚠️  Превью Twitch не скачалось, Discord получит анонс без картинки:', describe(error));
      return undefined;
    }
  }

  prepareFinished(input: FinishedInput): Prepared<void> {
    const text = renderDiscordFinished(input);
    return {
      text,
      send: async () => {
        await this.client.send({ embeds: [{ description: text }] });
      },
    };
  }
}

/** Файл для embed: тип должен быть картинкой, которую Discord покажет, размер — в пределах лимита. */
function toDiscordFile(name: string, type: string, data: Uint8Array): DiscordFile {
  const extension = DISCORD_IMAGE_EXTENSIONS[type];
  if (!extension) throw new Error(`тип ${type || 'неизвестный'} не картинка для Discord`);
  if (data.length === 0 || data.length > DISCORD_IMAGE_LIMIT) {
    throw new Error(`размер картинки ${data.length} Б вне допустимого`);
  }
  return { name: `${name}.${extension}`, type, data };
}

type ProbeResult =
  | { platform: Platform; status: 'live'; stream: LiveStream }
  | { platform: Platform; status: 'offline' }
  | { platform: Platform; status: 'unknown'; error: unknown };

/** Короткое описание ошибки для лога: у axios в message уже есть статус, тело — в ответе. */
function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { status?: number; data?: { message?: string } } }).response;
    const detail = response?.data?.message;
    return `HTTP ${response?.status ?? '?'}${detail ? `: ${detail}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Ссылка на канал площадки; undefined — площадка не настроена. */
export function channelUrl(config: Config, platform: Platform): string | undefined {
  switch (platform) {
    case 'twitch':
      return config.twitch && `https://twitch.tv/${config.twitch.login}`;
    case 'youtube':
      return config.youtube && `https://www.youtube.com/channel/${config.youtube.channelId}`;
    case 'vkvideo':
      return config.vkvideo && `${VK_LIVE_BASE}/${config.vkvideo.channel}`;
  }
}

export class Announcer {
  private readonly store: Store;
  private readonly watchers: BaseWatcher[];
  private readonly channels: DeliveryChannel[];
  private readonly config: Config;
  private readonly now: () => number;
  private readonly onEvent?: (event: AnnouncerEvent) => void;
  private readonly probeStates = new Map<Platform, PlatformState>();

  constructor(deps: AnnouncerDeps) {
    this.store = deps.store;
    this.watchers = deps.watchers;
    this.channels = [];
    if (deps.telegram && deps.config.telegram) {
      this.channels.push(new TelegramChannel(deps.telegram, deps.config.telegram.chatId, deps.image));
    }
    if (deps.discord) this.channels.push(new DiscordChannel(deps.discord, deps.image));
    this.config = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.onEvent = deps.onEvent;
  }

  /** Подписчик не должен ломать проверку эфира. */
  private emit(event: AnnouncerEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      console.error('❌ Ошибка в обработчике событий:', error instanceof Error ? error.message : error);
    }
  }

  async tick(): Promise<void> {
    const now = this.now();
    const probes = await this.probeAll();
    const live = probes.filter(
      (probe): probe is Extract<ProbeResult, { status: 'live' }> => probe.status === 'live'
    );

    for (const probe of probes) {
      if (probe.status === 'unknown') {
        // Только текст ошибки: полный дамп axios забивает лог на сотни строк.
        console.warn(`⚠️  ${PLATFORM_LABELS[probe.platform]}: не удалось проверить — ${describe(probe.error)}`);
        this.probeStates.set(probe.platform, {
          platform: probe.platform,
          state: 'error',
          error: describe(probe.error),
          checkedAt: now,
        });
      } else {
        this.probeStates.set(probe.platform, { platform: probe.platform, state: probe.status, checkedAt: now });
      }
    }

    const broadcast = this.store.openBroadcast();

    if (live.length === 0) {
      if (!broadcast) return;
      // Ошибка проверки — не повод закрывать эфир: площадка могла просто не ответить.
      const allKnownOffline = probes.every((probe) => probe.status === 'offline');
      if (allKnownOffline && now - broadcast.lastLiveAt > this.config.offlineGraceMs) {
        await this.finishBroadcast(broadcast.id, now);
      }
      return;
    }

    const current = broadcast ?? this.startBroadcast(now);
    this.store.touchBroadcast(current.id, now);

    for (const probe of live) {
      this.store.upsertStream(current.id, probe.stream, now);
    }
    // Площадку помечаем ушедшей, только если она ответила «офлайн» явно.
    for (const probe of probes) {
      if (probe.status === 'offline') this.store.endStream(current.id, probe.platform, now);
    }

    const fresh = this.store.openBroadcast();
    if (!fresh) return;

    // Анонс — снимок площадок на момент отправки: после неё сообщение не правим,
    // даже если площадка упала или подключилась позже.
    const started = this.store.deliveriesOf(fresh.id).length > 0;
    // Ждём остальные площадки: OBS поднимает их с разницей в десятки секунд.
    // Когда доставка начата, grace уже позади: недоставленные площадки повторяются каждый тик.
    // Со статическими ссылками остальные площадки для ссылок не нужны: уходим, как только в эфире приоритетная.
    const primaryLive =
      this.store.alwaysLinks().length > 0 &&
      this.store.liveStreamsOf(fresh.id).some((stream) => stream.platform === this.config.primaryPlatform);
    if (started || primaryLive || now - fresh.startedAt >= this.config.announceGraceMs) {
      await this.announce(fresh.id, now);
    }
  }

  private async probeAll(): Promise<ProbeResult[]> {
    const settled = await Promise.allSettled(this.watchers.map((watcher) => watcher.fetchLive()));

    return settled.map((result, index): ProbeResult => {
      const platform = this.watchers[index]!.platform;
      if (result.status === 'rejected') {
        return { platform, status: 'unknown', error: result.reason };
      }
      return result.value
        ? { platform, status: 'live', stream: result.value }
        : { platform, status: 'offline' };
    });
  }

  private startBroadcast(now: number) {
    console.log('🔴 Замечено начало эфира, ждём остальные площадки');
    return this.store.createBroadcast(now);
  }

  /** Ссылки всегда в фиксированном порядке платформ, независимо от того, кто стартовал первым. */
  private links(broadcastId: number): ChannelLink[] {
    const live = this.store.liveStreamsOf(broadcastId);
    return PLATFORMS.flatMap((platform): ChannelLink[] => {
      const stream = live.find((item) => item.platform === platform);
      if (!stream) return [];
      const link = { label: PLATFORM_LABELS[platform], url: stream.url };
      // Эфир VK Live виден и на vkvideo.ru — ставим обе ссылки, VK Video первой, как в итоге эфира.
      if (platform === 'vkvideo' && this.config.vkVideoReplayUrl) {
        return [{ label: 'VK Video', url: this.config.vkVideoReplayUrl }, link];
      }
      return [link];
    });
  }

  /**
   * Статические ссылки анонса; null — анонс собирается из живых стримов. До первой доставки список живой,
   * после — зафиксированный: правка списка во время эфира не меняет повтор для другой площадки.
   */
  private staticLinks(broadcastId: number, announced: boolean): ChannelLink[] | null {
    if (announced) return this.store.linksSnapshot(broadcastId)?.links ?? null;
    return this.alwaysChannelLinks();
  }

  private alwaysChannelLinks(): ChannelLink[] | null {
    const always = this.store.alwaysLinks();
    return always.length > 0 ? always.map(({ label, url }) => ({ label, url })) : null;
  }

  /**
   * Заголовок, игру и превью берём только с приоритетной площадки: на других
   * названия могут отличаться. Ищем и среди отвалившихся, чтобы заголовок не
   * пропадал из сообщения, пока площадка моргает.
   */
  private source(broadcastId: number) {
    return this.store
      .streamsOf(broadcastId)
      .find((stream) => stream.platform === this.config.primaryPlatform);
  }

  private async announce(broadcastId: number, now: number): Promise<void> {
    const source = this.source(broadcastId);
    const broadcast = this.store.openBroadcast();
    const announced = broadcast !== null && broadcast.announcedAt !== null;
    const fixedLinks = this.staticLinks(broadcastId, announced);
    const links = fixedLinks ?? this.links(broadcastId);
    if (links.length === 0) return;

    // Площадки фиксируются на первой попытке: добавленная позже догоняющего анонса не получит.
    if (this.store.deliveriesOf(broadcastId).length === 0) {
      this.store.startDeliveries(
        broadcastId,
        this.channels.map((channel) => channel.id)
      );
    }
    const rows = this.store.deliveriesOf(broadcastId);
    const pending = this.channels.filter((channel) =>
      rows.some((row) => row.channel === channel.id && row.state === 'pending')
    );
    if (pending.length === 0) return;

    // До первой доставки врезка живая, после — зафиксированная: повтор для другой площадки не должен подхватить новую /text.
    const customText = broadcast && broadcast.announcedAt !== null ? broadcast.announceText : this.store.announceText();
    const request: AnnounceRequest = {
      input: {
        title: source?.title ?? t(this.config.announceLanguage, 'announce.fallbackTitle'),
        game: source?.game,
        customText,
        links,
        language: this.config.announceLanguage,
      },
      customPhoto: this.store.announcePhoto(),
      thumbnailUrl: source?.thumbnailUrl,
      thumbnailPlatform: source?.platform,
    };

    let fatal: unknown;
    for (const channel of pending) {
      const prepared = channel.prepareAnnounce(request);

      if (this.config.dryRun) {
        console.log(`🧪 DRY_RUN, сообщение в ${channel.label} не отправлено:\n` + prepared.text);
        this.recordAnnounced(broadcastId, channel, now, { messageId: null, target: null }, customText, fixedLinks);
        continue;
      }

      try {
        const sent = await prepared.send();
        this.recordAnnounced(broadcastId, channel, now, sent, customText, fixedLinks);
        console.log(`✅ Анонс отправлен (${channel.label}): ${links.map((link) => link.label).join(', ')}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ Не удалось отправить анонс (${channel.label}):`, message);
        this.emit({ type: 'announce_failed', channel: channel.label, error: message });
        if (!channel.isPermanent(error)) continue; // не отмечена — попробуем в следующем тике
        if (channel.throwOnPermanent) fatal ??= error;
        else this.store.markDeliveryFailed(broadcastId, channel.id, message);
      }
    }

    if (fatal) throw fatal;
  }

  /** Записывает доставку; первая успешная запускает «анонсирован»: врезка гаснет, приложение получает событие. */
  private recordAnnounced(
    broadcastId: number,
    channel: DeliveryChannel,
    now: number,
    sent: Sent,
    customText: string | null,
    fixedLinks: ChannelLink[] | null
  ): void {
    const first = this.store.openBroadcast()?.announcedAt === null;
    this.store.markDelivered(broadcastId, channel.id, now, sent.messageId, sent.target);
    if (!first) return;
    this.store.markAnnounced(broadcastId, now, customText);
    this.store.setLinksSnapshot({ broadcastId, links: fixedLinks }, now);
    this.store.clearAnnounceText();
    this.emit({
      type: 'announced',
      platforms: this.store.liveStreamsOf(broadcastId).map((stream) => PLATFORM_LABELS[stream.platform]),
    });
  }

  private async finishBroadcast(broadcastId: number, now: number): Promise<void> {
    const source = this.source(broadcastId);
    const broadcast = this.store.openBroadcast();
    this.store.endBroadcast(broadcastId, now);
    console.log('⚫️ Эфир завершён');

    // Итог шлём только к эфиру, о котором объявляли. Сам анонс не трогаем.
    if (!this.config.announceEnd || !broadcast || broadcast.announcedAt === null) return;

    // Без хвоста offlineGraceMs: эфир кончился, когда площадки замолчали, а не когда мы это признали.
    const durationMs = broadcast.lastLiveAt - broadcast.startedAt;
    const input: FinishedInput = {
      title: source?.title ?? t(this.config.announceLanguage, 'announce.fallbackTitle'),
      game: source?.game,
      durationMs,
      links: this.channelLinks(),
      language: this.config.announceLanguage,
    };

    // Итог идёт только туда, куда дошёл анонс; каждая площадка независимо и без повторов.
    const delivered = this.store.deliveriesOf(broadcastId).filter((row) => row.state === 'sent');
    let sentAny = false;
    for (const channel of this.channels) {
      if (!delivered.some((row) => row.channel === channel.id)) continue;
      const prepared = channel.prepareFinished(input);

      if (this.config.dryRun) {
        console.log(`🧪 DRY_RUN, итог эфира в ${channel.label} не отправлен:\n` + prepared.text);
        sentAny = true;
        continue;
      }

      try {
        await prepared.send();
        console.log(`✅ Итог эфира отправлен (${channel.label})`);
        sentAny = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ Не удалось отправить итог эфира (${channel.label}):`, message);
      }
    }
    if (sentAny) this.emit({ type: 'finished', durationMs });
  }

  /** Ссылки на каналы для итогового сообщения — по настроенным площадкам, а не по тем, что были в эфире. */
  private channelLinks(): ChannelLink[] {
    return PLATFORMS.flatMap((platform): ChannelLink[] => {
      const url = channelUrl(this.config, platform);
      if (!url) return [];
      const link = { label: PLATFORM_LABELS[platform], url };
      if (platform === 'vkvideo' && this.config.vkVideoReplayUrl) {
        return [{ label: 'VK Video', url: this.config.vkVideoReplayUrl }, link];
      }
      return [link];
    });
  }

  /** Для команды /status и панели. */
  status(): BroadcastStatus | null {
    const broadcast = this.store.openBroadcast();
    if (!broadcast) return null;
    const deliveries = this.store.deliveriesOf(broadcast.id);
    const telegram = deliveries.find((row) => row.channel === 'telegram' && row.state === 'sent');
    return {
      startedAt: broadcast.startedAt,
      announcedAt: broadcast.announcedAt,
      chatId: telegram?.target ?? null,
      messageId: telegram?.messageId ? Number(telegram.messageId) : null,
      platforms: this.store.liveStreamsOf(broadcast.id).map((stream) => stream.platform),
      deliveries: this.channels.flatMap((channel) => {
        const row = deliveries.find((item) => item.channel === channel.id);
        return row ? [{ channel: channel.id, label: channel.label, state: row.state }] : [];
      }),
    };
  }

  /** Последняя проверка по каждой настроенной площадке; до первой проверки площадки нет в списке. */
  platformStates(): PlatformState[] {
    return this.watchers.flatMap((watcher) => {
      const state = this.probeStates.get(watcher.platform);
      return state ? [state] : [];
    });
  }

  /** Данные превью и тестового анонса: общие, чтобы они не расходились. */
  private previewContext() {
    const broadcast = this.store.openBroadcast();
    const source = broadcast ? this.source(broadcast.id) : undefined;
    const language = this.config.announceLanguage;
    const title = source?.title ?? t(language, 'announce.sampleTitle');
    const game = source ? source.game : t(language, 'announce.sampleGame');
    const links = this.channelLinks();
    return { broadcast, source, title, game, links, announceLinks: this.alwaysChannelLinks() ?? links, language };
  }

  /**
   * Настоящий анонс, как в превью, но только в одну площадку и с пометкой «Тест»
   * (в Telegram — без звука). В базу не пишет, состояние эфира не трогает,
   * DRY_RUN не учитывает; ошибка уходит вызывающему.
   */
  async testAnnounce(channelId: 'telegram' | 'discord'): Promise<void> {
    const channel = this.channels.find((item) => item.id === channelId);
    if (!channel) throw new Error(`${channelId}: площадка не настроена`);
    const { source, title, game, announceLinks, language } = this.previewContext();
    await channel
      .prepareAnnounce({
        input: {
          title,
          game,
          customText: this.store.announceText(),
          links: announceLinks,
          language,
          marker: t(language, 'announce.testMarker'),
        },
        customPhoto: this.store.announcePhoto(),
        thumbnailUrl: source?.thumbnailUrl,
        thumbnailPlatform: source?.platform,
        silent: true,
      })
      .send();
  }

  /**
   * Оба сообщения так, как они уйдут сейчас: с текущей врезкой и, если эфир идёт,
   * с настоящими названием и игрой. Ссылки — на каналы, ведь эфира может и не быть.
   */
  preview(): { announce: string; finished: string } {
    const { broadcast, title, game, links, announceLinks, language } = this.previewContext();

    return {
      announce: renderAnnounce({ title, game, customText: this.store.announceText(), links: announceLinks, language }),
      finished: renderFinished({
        title,
        game,
        durationMs: broadcast ? this.now() - broadcast.startedAt : (2 * 60 + 47) * 60_000,
        links,
        language,
      }),
    };
  }
}
