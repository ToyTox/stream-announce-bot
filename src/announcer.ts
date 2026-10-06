import { renderAnnounce, renderFinished, ChannelLink } from './announceTemplate.js';
import type { Config } from './config.js';
import { Store } from './store.js';
import { TelegramClient, TelegramError } from './telegram/client.js';
import { LiveStream, PLATFORMS, PLATFORM_LABELS, Platform } from './types.js';
import type { BaseWatcher } from './watchers/base.js';
import { CHANNEL_BASE as VK_LIVE_BASE } from './watchers/vkvideo.js';

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

    // Анонс — снимок площадок на момент отправки: после неё сообщение не правим,
    // даже если площадка упала или подключилась позже.
    if (fresh.announcedAt === null && now - fresh.startedAt >= this.config.announceGraceMs) {
      // Ждём остальные площадки: OBS поднимает их с разницей в десятки секунд.
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
    const links = this.links(broadcastId);
    if (links.length === 0) return;

    const customText = this.store.announceText();
    const text = renderAnnounce({
      title: source?.title ?? 'Трансляция',
      game: source?.game,
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
      const message = source?.thumbnailUrl
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
        console.log(`✅ Анонс отправлен: ${links.map((link) => link.label).join(', ')}`);
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

  private async finishBroadcast(broadcastId: number, now: number): Promise<void> {
    const source = this.source(broadcastId);
    const broadcast = this.store.openBroadcast();
    this.store.endBroadcast(broadcastId, now);
    console.log('⚫️ Эфир завершён');

    // Итог шлём только к эфиру, о котором объявляли. Сам анонс не трогаем.
    if (!this.config.announceEnd || !broadcast || broadcast.announcedAt === null) return;

    const text = renderFinished({
      title: source?.title ?? 'Трансляция',
      game: source?.game,
      // Без хвоста offlineGraceMs: эфир кончился, когда площадки замолчали, а не когда мы это признали.
      durationMs: broadcast.lastLiveAt - broadcast.startedAt,
      links: this.channelLinks(),
    });

    if (this.config.dryRun) {
      console.log('🧪 DRY_RUN, итог эфира не отправлен:\n' + text);
      return;
    }

    try {
      await this.telegram.sendMessage(text);
      console.log('✅ Итог эфира отправлен');
    } catch (error) {
      const message = error instanceof TelegramError ? error.message : String(error);
      console.error('❌ Не удалось отправить итог эфира:', message);
    }
  }

  /** Ссылки на каналы для итогового сообщения — по настроенным площадкам, а не по тем, что были в эфире. */
  private channelLinks(): ChannelLink[] {
    const { twitch, youtube, vkvideo, vkVideoReplayUrl } = this.config;
    const links: ChannelLink[] = [];
    if (twitch) links.push({ label: 'Twitch', url: `https://twitch.tv/${twitch.login}` });
    if (youtube) {
      links.push({ label: 'YouTube', url: `https://www.youtube.com/channel/${youtube.channelId}` });
    }
    if (vkVideoReplayUrl) links.push({ label: 'VK Video', url: vkVideoReplayUrl });
    if (vkvideo) links.push({ label: 'VK Live', url: `${VK_LIVE_BASE}/${vkvideo.channel}` });
    return links;
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
