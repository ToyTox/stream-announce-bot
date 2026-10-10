import { parse as parseEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import type { AnnouncerEvent } from './announcer.js';
import { Runtime, type BotFactory } from './bot.js';
import { ConfigError, loadWebConfig, type Env } from './config.js';
import { startPanel, type Panel } from './web/server.js';

/**
 * Общая точка входа для терминала (src/index.ts) и десктопного приложения:
 * читает .env по указанному пути, запускает бота и панель, умеет всё остановить.
 */

export interface AppOptions {
  /** Файл настроек; не зависит от текущей папки процесса. */
  envPath: string;
  /** Порт панели; по умолчанию WEB_PORT из .env (3210). */
  port?: number;
  /** Занятый порт заменить на любой свободный — для десктопа, где два запуска не страшны. */
  fallbackPort?: boolean;
  /** Поднимать панель, даже если в .env WEB_ENABLED=false: в десктопе окно без неё пустое. */
  forcePanel?: boolean;
  /** Значения по умолчанию для ключей, которых нет в .env (например, DATABASE_PATH). */
  defaults?: Env;
  /** Подмешивать ли переменные окружения процесса; они важнее .env, как у dotenv. */
  inheritProcessEnv?: boolean;
  onEvent?: (event: AnnouncerEvent) => void;
  /** Подменяется в тестах, чтобы не ходить в сеть. */
  botFactory?: BotFactory;
}

export interface App {
  runtime: Runtime;
  env: Env;
  panel?: Panel;
  panelUrl?: string;
  stop(): Promise<void>;
}

function readEnvFile(path: string): Env {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function startApp(options: AppOptions): Promise<App> {
  const env: Env = { ...readEnvFile(options.envPath), ...(options.inheritProcessEnv === false ? {} : process.env) };
  for (const [key, value] of Object.entries(options.defaults ?? {})) {
    if (!env[key]?.trim()) env[key] = value;
  }

  const runtime = new Runtime(options.botFactory, options.onEvent);
  runtime.start(env);

  let panel: Panel | undefined;
  try {
    const web = loadWebConfig(env);
    if (web.enabled || options.forcePanel) {
      panel = await startPanel(
        { runtime, env, envPath: options.envPath, defaults: options.defaults },
        options.port ?? web.port,
        { fallbackPort: options.fallbackPort }
      );
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`❌ Панель выключена: ${error.message}`);
  }

  return {
    runtime,
    env,
    panel,
    panelUrl: panel && `http://localhost:${panel.port}`,
    async stop() {
      await panel?.close();
      await runtime.stop();
    },
  };
}
