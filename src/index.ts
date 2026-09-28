import 'dotenv/config';
import { Announcer } from './announcer.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { TelegramClient } from './telegram/client.js';
import { CommandListener } from './telegram/commands.js';
import { PLATFORM_LABELS } from './types.js';
import type { BaseWatcher } from './watchers/base.js';
import { TwitchWatcher } from './watchers/twitch.js';
import { VkVideoWatcher } from './watchers/vkvideo.js';
import { YouTubeWatcher } from './watchers/youtube.js';

function buildWatchers(config: Config): BaseWatcher[] {
  const watchers: BaseWatcher[] = [];
  if (config.twitch) watchers.push(new TwitchWatcher(config.twitch));
  if (config.youtube) watchers.push(new YouTubeWatcher(config.youtube));
  if (config.vkvideo) watchers.push(new VkVideoWatcher(config.vkvideo));
  return watchers;
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

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
    listener = new CommandListener({
      telegram,
      store,
      announcer,
      adminId: config.telegram.adminId,
    });
    listener.start();
    console.log('💬 Команды бота принимаются');
  } else {
    console.log('💬 TELEGRAM_ADMIN_ID не задан — команды бота выключены');
  }

  // Защита от наложения: тик может идти дольше интервала, если площадки тормозят.
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      await announcer.tick();
    } catch (error) {
      console.error('❌ Ошибка в проверке эфира:', error instanceof Error ? error.message : error);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void tick(), config.pollIntervalMs);
  void tick();

  const shutdown = (signal: string) => {
    console.log(`\n👋 ${signal}, выключаюсь`);
    clearInterval(timer);
    listener?.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
