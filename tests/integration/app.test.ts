import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApp, type App } from '../../src/app.js';
import type { Bot, BotFactory } from '../../src/bot.js';
import type { Config } from '../../src/config.js';

/** Общая точка входа: свой .env, свой порт, фейковый бот — в сеть не ходим. */

let dir: string;
let envPath: string;
let app: App | undefined;
let blocker: Server | undefined;
let configs: Config[];

const factory: BotFactory = (config) => {
  configs.push(config);
  return { config, tickNow: async () => {}, stop: async () => {} } as unknown as Bot;
};

function occupy(): Promise<number> {
  blocker = createServer();
  return new Promise((resolve) => {
    blocker!.listen(0, '127.0.0.1', () => resolve((blocker!.address() as { port: number }).port));
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  configs = [];
  dir = mkdtempSync(join(tmpdir(), 'app-'));
  envPath = join(dir, '.env');
  writeFileSync(
    envPath,
    `TELEGRAM_BOT_TOKEN=tok\nTELEGRAM_CHAT_ID=-100123\nVKVIDEO_CHANNEL=me\nDRY_RUN=true\nDATABASE_PATH=${join(dir, 'x.db')}\n`
  );
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
  await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
  blocker = undefined;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('startApp', () => {
  it('читает .env по указанному пути и отдаёт реальный адрес панели', async () => {
    app = await startApp({ envPath, port: 0, inheritProcessEnv: false, botFactory: factory });

    expect(configs[0]).toMatchObject({ dryRun: true, telegram: { botToken: 'tok', chatId: '-100123' } });
    expect(app.runtime.bot).not.toBeNull();
    expect(app.panelUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(app.panel!.port).toBeGreaterThan(0);
  });

  it('подставляет значения по умолчанию только для отсутствующих ключей', async () => {
    writeFileSync(envPath, 'TELEGRAM_BOT_TOKEN=tok\nTELEGRAM_CHAT_ID=-1\nVKVIDEO_CHANNEL=me\n');

    app = await startApp({
      envPath,
      port: 0,
      inheritProcessEnv: false,
      defaults: { DATABASE_PATH: '/data/bot.db', DRY_RUN: 'true' },
      botFactory: factory,
    });

    expect(configs[0]?.databasePath).toBe('/data/bot.db');
  });

  it('занятый порт: с fallbackPort берёт свободный, без него панели нет', async () => {
    const busy = await occupy();

    app = await startApp({ envPath, port: busy, fallbackPort: true, inheritProcessEnv: false, botFactory: factory });
    expect(app.panel!.port).not.toBe(busy);
    expect(app.panelUrl).toBe(`http://localhost:${app.panel!.port}`);
    await app.stop();

    app = await startApp({ envPath, port: busy, inheritProcessEnv: false, botFactory: factory });
    expect(app.panel).toBeUndefined();
    expect(app.runtime.bot).not.toBeNull();
  });

  it('без .env бот не стартует, а панель поднимается и показывает ошибку', async () => {
    rmSync(envPath);

    app = await startApp({ envPath, port: 0, inheritProcessEnv: false, botFactory: factory });

    expect(app.runtime.bot).toBeNull();
    expect(app.runtime.configError).toContain('TELEGRAM_BOT_TOKEN');
    expect(app.panel).toBeDefined();
  });

  it('forcePanel поднимает панель даже при WEB_ENABLED=false', async () => {
    writeFileSync(envPath, 'WEB_ENABLED=false\n');

    app = await startApp({ envPath, port: 0, inheritProcessEnv: false, botFactory: factory });
    expect(app.panel).toBeUndefined();

    app = await startApp({ envPath, port: 0, forcePanel: true, inheritProcessEnv: false, botFactory: factory });
    expect(app.panel).toBeDefined();
  });
});
