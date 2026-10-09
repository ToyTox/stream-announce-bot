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
  private readonly telegram: TelegramClient;
  private readonly config: Config;
  private readonly now: () => number;
  private readonly probeStates = new Map<Platform, PlatformState>();

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
    // Своя картинка из лички важнее превью Twitch; живёт, пока её не сбросят через /image -.
    const photo = this.store.announcePhoto() ?? source?.thumbnailUrl;
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
      const message = photo
        ? await this.sendWithPhotoFallback(photo, text)
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
  private async sendWithPhotoFallback(photo: string, caption: string) {
    try {
      return await this.telegram.sendPhoto(photo, caption);
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
    return {
      startedAt: broadcast.startedAt,
      announcedAt: broadcast.announcedAt,
      chatId: broadcast.chatId,
      messageId: broadcast.messageId,
      platforms: this.store.liveStreamsOf(broadcast.id).map((stream) => stream.platform),
    };
  }

  /** Последняя проверка по каждой настроенной площадке; до первой проверки площадки нет в списке. */
  platformStates(): PlatformState[] {
    return this.watchers.flatMap((watcher) => {
      const state = this.probeStates.get(watcher.platform);
      return state ? [state] : [];
    });
  }

  /**
   * Оба сообщения так, как они уйдут сейчас: с текущей врезкой и, если эфир идёт,
   * с настоящими названием и игрой. Ссылки — на каналы, ведь эфира может и не быть.
   */
  preview(): { announce: string; finished: string } {
    const broadcast = this.store.openBroadcast();
    const source = broadcast ? this.source(broadcast.id) : undefined;
    const title = source?.title ?? 'Название стрима на Twitch';
    const game = source ? source.game : 'Игра на Twitch';
    const links = this.channelLinks();

    return {
      announce: renderAnnounce({ title, game, customText: this.store.announceText(), links }),
      finished: renderFinished({
        title,
        game,
        durationMs: broadcast ? this.now() - broadcast.startedAt : (2 * 60 + 47) * 60_000,
        links,
      }),
    };
  }
}
