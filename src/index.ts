import { resolve } from 'node:path';
import { startApp } from './app.js';
import { captureConsole } from './log.js';

async function main(): Promise<void> {
  captureConsole();

  // .env ищем в текущей папке, как раньше делал dotenv/config.
  const app = await startApp({ envPath: resolve('.env') });

  // Без бота и без панели процессу делать нечего — ошибка конфига уже в логе.
  if (!app.runtime.bot && !app.panel) process.exit(1);
  if (!app.runtime.bot) console.log('⚠️  Бот не запущен — исправьте настройки в панели');

  const shutdown = async (signal: string) => {
    console.log(`\n👋 ${signal}, выключаюсь`);
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
