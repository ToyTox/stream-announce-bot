import { Announcer } from './announcer.js';
import { ConfigError, loadConfig, type Config, type Env } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { TelegramClient } from './telegram/client.js';
import { CommandListener } from './telegram/commands.js';
import { PLATFORM_LABELS } from './types.js';
import type { BaseWatcher } from './watchers/base.js';
import { TwitchWatcher } from './watchers/twitch.js';
import { VkVideoWatcher } from './watchers/vkvideo.js';
import { YouTubeWatcher } from './watchers/youtube.js';

/** Работающий бот: всё, что собрано из одного конфига, и способ это остановить. */
export interface Bot {
  config: Config;
  store: Store;
  telegram: TelegramClient;
  announcer: Announcer;
  /** Внеочередная проверка; если проверка уже идёт — дожидается её. */
  tickNow(): Promise<void>;
  /** Останавливает опрос и команды, дожидается текущей проверки и закрывает базу. */
  stop(): Promise<void>;
}

function buildWatchers(config: Config): BaseWatcher[] {
  const watchers: BaseWatcher[] = [];
  if (config.twitch) watchers.push(new TwitchWatcher(config.twitch));
  if (config.youtube) watchers.push(new YouTubeWatcher(config.youtube));
  if (config.vkvideo) watchers.push(new VkVideoWatcher(config.vkvideo));
  return watchers;
}

export function startBot(config: Config): Bot {
  const db = openDb(config.databasePath);
  const store = new Store(db);
  const telegram = new TelegramClient(
    config.telegram.botToken,
    config.telegram.chatId,
    config.telegram.topicId
  );
  const watchers = buildWatchers(config);
  const announcer = new Announcer({ store, watchers, telegram, config });

  console.log(
    `👀 Слежу за площадками: ${watchers.map((watcher) => PLATFORM_LABELS[watcher.platform]).join(', ')}`
  );
  console.log(
    `⏱️  Опрос раз в ${Math.round(config.pollIntervalMs / 1000)} с, ` +
      `пауза перед анонсом ${Math.round(config.announceGraceMs / 1000)} с, ` +
      `окончание эфира через ${Math.round(config.offlineGraceMs / 1000)} с молчания`
  );
  if (config.dryRun) console.log('🧪 DRY_RUN: сообщения в Telegram не уходят');

  let listener: CommandListener | undefined;
  if (config.telegram.adminId !== undefined) {
    listener = new CommandListener({ telegram, store, announcer, adminId: config.telegram.adminId });
    listener.start();
    console.log('💬 Команды бота принимаются');
  } else {
    console.log('💬 TELEGRAM_ADMIN_ID не задан — команды бота выключены');
  }

  // Защита от наложения: тик может идти дольше интервала, если площадки тормозят.
  let current: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    current ??= announcer
      .tick()
      .catch((error: unknown) => {
        console.error('❌ Ошибка в проверке эфира:', error instanceof Error ? error.message : error);
      })
      .finally(() => {
        current = null;
      });
    return current;
  };

  const timer = setInterval(() => void tick(), config.pollIntervalMs);
  void tick();

  return {
    config,
    store,
    telegram,
    announcer,
    tickNow: tick,
    async stop() {
      clearInterval(timer);
      await listener?.stop();
      await current;
      db.close();
    },
  };
}

export type BotFactory = (config: Config) => Bot;

/**
 * Держит текущего бота и умеет пересобрать его с новым конфигом. Если конфиг
 * невалиден, бот не запускается, а ошибка остаётся в configError — панель её покажет.
 */
export class Runtime {
  bot: Bot | null = null;
  configError: string | null = null;

  constructor(private readonly factory: BotFactory = startBot) {}

  start(env: Env): void {
    try {
      this.bot = this.factory(loadConfig(env));
      this.configError = null;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      this.configError = error.message;
      console.error(`❌ ${error.message}`);
    }
  }

  async restart(env: Env): Promise<void> {
    console.log('🔄 Перезапускаю бота с новыми настройками');
    await this.stop();
    this.start(env);
  }

  async stop(): Promise<void> {
    const bot = this.bot;
    this.bot = null;
    await bot?.stop();
  }
}
