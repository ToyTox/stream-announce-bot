import 'dotenv/config';
import { resolve } from 'node:path';
import { Runtime } from './bot.js';
import { ConfigError, loadWebConfig } from './config.js';
import { captureConsole } from './log.js';
import { startPanel, type Panel } from './web/server.js';

async function main(): Promise<void> {
  captureConsole();

  const runtime = new Runtime();
  runtime.start(process.env);

  let panel: Panel | undefined;
  try {
    const web = loadWebConfig();
    if (web.enabled) {
      // Тот же .env, что прочитал dotenv/config: он ищет его в текущей папке.
      panel = startPanel({ runtime, env: process.env, envPath: resolve('.env') }, web.port);
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`❌ Панель выключена: ${error.message}`);
  }

  // Без бота и без панели процессу делать нечего — ошибка конфига уже в логе.
  if (!runtime.bot && !panel) process.exit(1);
  if (!runtime.bot) console.log('⚠️  Бот не запущен — исправьте настройки в панели');

  const shutdown = async (signal: string) => {
    console.log(`\n👋 ${signal}, выключаюсь`);
    await panel?.close();
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
