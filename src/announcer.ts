import { renderAnnounce, AnnounceLink } from './announceTemplate.js';
import type { Config } from './config.js';
import { Store } from './store.js';
import { TelegramClient, TelegramError } from './telegram/client.js';
import { LiveStream, PLATFORMS, PLATFORM_LABELS, Platform } from './types.js';
import type { BaseWatcher } from './watchers/base.js';

/**
 * Оркестратор. Сущность здесь — не «стрим на платформе», а эфир: OBS поднимает
 * все площадки разом, поэтому сообщение всегда одно, а ссылки в нём — только на те
 * платформы, которые действительно в эфире.
 */

export interface AnnouncerDeps {
  store: Store;
  watchers: BaseWatcher[];
  telegram: TelegramClient;
  config: Config;
  /** Подменяется в тестах, чтобы гонять grace-периоды без ожидания. */
  now?: () => number;
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

export class Announcer {
  private readonly store: Store;
  private readonly watchers: BaseWatcher[];
  private readonly telegram: TelegramClient;
  private readonly config: Config;
  private readonly now: () => number;
  /** Последний отправленный текст: без него правка уходила бы каждый тик вхолостую. */
  private lastRendered = new Map<number, string>();

  constructor(deps: AnnouncerDeps) {
    this.store = deps.store;
    this.watchers = deps.watchers;
    this.telegram = deps.telegram;
    this.config = deps.config;
    this.now = deps.now ?? (() => Date.now());
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

    if (fresh.announcedAt === null) {
      // Ждём остальные площадки: OBS поднимает их с разницей в десятки секунд.
      if (now - fresh.startedAt >= this.config.announceGraceMs) {
        await this.announce(fresh.id, now);
      }
      return;
    }

    await this.syncAnnouncement(fresh.id);
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

  /** Ссылки всегда в фиксированном порядке платформ, чтобы правка сообщения не переставляла их. */
  private links(broadcastId: number): AnnounceLink[] {
    const live = this.store.liveStreamsOf(broadcastId);
    return PLATFORMS.flatMap((platform) => {
      const stream = live.find((item) => item.platform === platform);
      return stream ? [{ platform, url: stream.url }] : [];
    });
  }

  /** Заголовок, игру и превью берём с приоритетной площадки, иначе с первой доступной. */
  private source(broadcastId: number) {
    const live = this.store.liveStreamsOf(broadcastId);
    const order: Platform[] = [
      this.config.primaryPlatform,
      ...PLATFORMS.filter((platform) => platform !== this.config.primaryPlatform),
    ];
    for (const platform of order) {
      const stream = live.find((item) => item.platform === platform);
      if (stream) return stream;
    }
    return undefined;
  }

  private async announce(broadcastId: number, now: number): Promise<void> {
    const source = this.source(broadcastId);
    const links = this.links(broadcastId);
    if (!source || links.length === 0) return;

    const customText = this.store.announceText();
    const text = renderAnnounce({
      title: source.title ?? 'Трансляция',
      game: source.game,
      customText,
      links,
    });

    if (this.config.dryRun) {
      console.log('🧪 DRY_RUN, сообщение не отправлено:\n' + text);
      this.store.markAnnounced(broadcastId, now, this.config.telegram.chatId, null, customText);
      this.store.clearAnnounceText();
      return;
    }

    try {
      const message = source.thumbnailUrl
        ? await this.sendWithPhotoFallback(source.thumbnailUrl, text)
        : await this.telegram.sendMessage(text);

      this.store.markAnnounced(
        broadcastId,
        now,
        this.config.telegram.chatId,
        message.message_id,
        customText
      );
      this.store.clearAnnounceText();
      this.lastRendered.set(broadcastId, text);
      console.log(`✅ Анонс отправлен: ${links.map((link) => PLATFORM_LABELS[link.platform]).join(', ')}`);
    } catch (error) {
      // Анонс не отмечен отправленным — попробуем в следующем тике.
      const message = error instanceof TelegramError ? error.message : String(error);
      console.error('❌ Не удалось отправить анонс:', message);
      if (error instanceof TelegramError && !error.retriable) throw error;
    }
  }

  /** Превью может не подгрузиться на стороне Telegram — тогда шлём текстом. */
  private async sendWithPhotoFallback(photoUrl: string, caption: string) {
    try {
      return await this.telegram.sendPhoto(photoUrl, caption);
    } catch (error) {
      if (error instanceof TelegramError && error.code === 'upstream') {
        console.warn('⚠️  Превью не ушло, отправляю текстом:', error.message);
        return this.telegram.sendMessage(caption);
      }
      throw error;
    }
  }

  /** Состав площадок изменился после анонса — правим то же сообщение, нового не шлём. */
  private async syncAnnouncement(broadcastId: number): Promise<void> {
    const broadcast = this.store.openBroadcast();
    if (!broadcast || broadcast.messageId === null) return;

    const source = this.source(broadcastId);
    const links = this.links(broadcastId);
    if (!source || links.length === 0) return;

    const text = renderAnnounce({
      title: source.title ?? 'Трансляция',
      game: source.game,
      customText: broadcast.announceText,
      links,
    });

    if (this.lastRendered.get(broadcastId) === text) return;
    if (this.config.dryRun) {
      console.log('🧪 DRY_RUN, сообщение не отредактировано:\n' + text);
      this.lastRendered.set(broadcastId, text);
      return;
    }

    await this.editAnnouncement(broadcast.messageId, text);
    this.lastRendered.set(broadcastId, text);
    console.log(`✏️  Сообщение обновлено: ${links.map((link) => PLATFORM_LABELS[link.platform]).join(', ')}`);
  }

  private async finishBroadcast(broadcastId: number, now: number): Promise<void> {
    const source = this.source(broadcastId) ?? this.store.streamsOf(broadcastId)[0];
    const broadcast = this.store.openBroadcast();
    this.store.endBroadcast(broadcastId, now);
    this.lastRendered.delete(broadcastId);
    console.log('⚫️ Эфир завершён');

    if (!this.config.editOnEnd || !broadcast || broadcast.messageId === null || this.config.dryRun) {
      return;
    }

    const text = renderAnnounce({
      title: source?.title ?? 'Трансляция',
      game: source?.game,
      customText: broadcast.announceText,
      links: [],
      endedAfterMs: now - broadcast.startedAt,
    });

    await this.editAnnouncement(broadcast.messageId, text);
  }

  /**
   * Анонс мог уйти как фото с подписью или как текст — от этого зависит метод правки.
   * Тип сообщения не храним: пробуем подпись, а на «нет подписи» переключаемся на текст.
   */
  private async editAnnouncement(messageId: number, text: string): Promise<void> {
    try {
      await this.telegram.editMessageCaption(messageId, text);
    } catch (error) {
      const message = error instanceof TelegramError ? error.message : String(error);
      // «message is not modified» — норма: состав ссылок не изменился.
      if (/not modified/i.test(message)) return;
      if (/no caption|message to edit|can't be edited/i.test(message)) {
        try {
          await this.telegram.editMessageText(messageId, text);
          return;
        } catch (textError) {
          const textMessage = textError instanceof TelegramError ? textError.message : String(textError);
          if (/not modified/i.test(textMessage)) return;
          console.error('❌ Не удалось обновить сообщение:', textMessage);
          return;
        }
      }
      console.error('❌ Не удалось обновить сообщение:', message);
    }
  }

  /** Для команды /status. */
  status(): { startedAt: number; platforms: Platform[] } | null {
    const broadcast = this.store.openBroadcast();
    if (!broadcast) return null;
    return {
      startedAt: broadcast.startedAt,
      platforms: this.store.liveStreamsOf(broadcast.id).map((stream) => stream.platform),
    };
  }
}
