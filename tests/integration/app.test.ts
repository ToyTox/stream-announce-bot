import { once } from 'node:events';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApp, type App } from '../../src/app.js';
import type { Bot, BotFactory } from '../../src/bot.js';
import type { Config } from '../../src/config.js';
import { discoverTailscaleAddress, tailscaleAddressAssigned } from '../../src/web/tailscale.js';

/** Общая точка входа: свой .env, свой порт, фейковый бот — в сеть не ходим. */

let dir: string;
let envPath: string;
let app: App | undefined;
let blocker: Server | undefined;
let configs: Config[];

vi.mock('../../src/web/tailscale.js');
const tailscaleIp = '100.100.10.20';

const factory: BotFactory = (config) => {
  configs.push(config);
  return { config, tickNow: async () => {}, stop: async () => {} } as unknown as Bot;
};

function occupy(host = '127.0.0.1', port = 0): Promise<number> {
  blocker = createServer();
  return new Promise((resolve) => {
    blocker!.listen(port, host, () => resolve((blocker!.address() as { port: number }).port));
  });
}

async function pairingAvailable(): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${app!.panel!.port}/api/pairing`);
  return (await res.json() as { available: boolean }).available;
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
  vi.resetAllMocks();
});

describe('startApp', () => {
  it('читает .env по указанному пути и отдаёт реальный адрес панели', async () => {
    app = await startApp({ envPath, port: 0, inheritProcessEnv: false, botFactory: factory });

    expect(configs[0]).toMatchObject({ dryRun: true, telegram: { botToken: 'tok', chatId: '-100123' } });
    expect(app.runtime.bot).not.toBeNull();
    expect(app.panelUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(app.panel!.port).toBeGreaterThan(0);
    expect(app.panel!.server.address()).toMatchObject({ address: '127.0.0.1' });
    expect(discoverTailscaleAddress).not.toHaveBeenCalled();
    expect(await pairingAvailable()).toBe(false);
    await expect(once(createConnection(app.panel!.port, '::1'), 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('стартует без Telegram, если задан Discord', async () => {
    writeFileSync(
      envPath,
      `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1/tok\nVKVIDEO_CHANNEL=me\nTELEGRAM_ADMIN_ID=7\nDATABASE_PATH=${join(dir, 'x.db')}\n`
    );

    app = await startApp({ envPath, port: 0, inheritProcessEnv: false, botFactory: factory });

    expect(configs[0]?.telegram).toBeUndefined();
    expect(configs[0]?.discord).toBeDefined();
    expect(app.runtime.bot).not.toBeNull();
  });

  it('без Telegram и Discord бот не стартует, панель показывает причину', async () => {
    writeFileSync(envPath, 'VKVIDEO_CHANNEL=me\n');

    app = await startApp({ envPath, port: 0, inheritProcessEnv: false, botFactory: factory });

    expect(app.runtime.bot).toBeNull();
    expect(app.runtime.configError).toContain('площадка доставки');
    expect(app.panel).toBeDefined();
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
    expect(app.runtime.configError).toContain('площадка доставки');
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

describe('startApp с удалённым API', () => {
  beforeEach(() => {
    appendFileSync(envPath, 'REMOTE_ENABLED=true\n');
    vi.mocked(discoverTailscaleAddress).mockResolvedValue({ address: tailscaleIp, interfaceName: 'utun4' });
    vi.mocked(tailscaleAddressAssigned).mockReturnValue(true);
  });

  function useLoopbackForTailscale() {
    const listen = HttpServer.prototype.listen;
    return vi.spyOn(HttpServer.prototype, 'listen').mockImplementation(function (this: HttpServer, ...args: unknown[]) {
      if (args[1] === tailscaleIp) args[1] = '::1';
      return Reflect.apply(listen, this, args);
    });
  }

  it.each([false, true])('запускает API из общей точки входа (desktop fallback: %s) и закрывает оба соединения', async (desktop) => {
    const port = desktop ? await occupy() : 0;
    const listen = useLoopbackForTailscale();
    app = await startApp({ envPath, port, fallbackPort: desktop, forcePanel: desktop, inheritProcessEnv: false, botFactory: factory });
    const actualPort = app.panel!.port;
    expect(actualPort).not.toBe(port);
    expect(listen).toHaveBeenCalledWith(actualPort, tailscaleIp, expect.any(Function));
    expect(await pairingAvailable()).toBe(true);

    const sockets = [createConnection(actualPort, '127.0.0.1'), createConnection(actualPort, '::1')];
    await Promise.all(sockets.map((socket) => once(socket, 'connect')));
    const closed = sockets.map((socket) => new Promise<void>((resolve, reject) => {
      socket.once('close', () => resolve());
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
    }));
    await app.stop();
    await Promise.all(closed);
    app = undefined;
    for (const host of ['127.0.0.1', '::1']) {
      await expect(once(createConnection(actualPort, host), 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }
  });

  it('CLI с выключенной панелью не запускает обнаружение, desktop принудительно включает панель', async () => {
    appendFileSync(envPath, 'WEB_ENABLED=false\n');
    app = await startApp({ envPath, port: 0, inheritProcessEnv: false, botFactory: factory });
    expect(app.panel).toBeUndefined();
    expect(discoverTailscaleAddress).not.toHaveBeenCalled();
    await app.stop();

    useLoopbackForTailscale();
    app = await startApp({ envPath, port: 0, forcePanel: true, inheritProcessEnv: false, botFactory: factory });
    expect(await pairingAvailable()).toBe(true);
  });

  it('отказ обнаружения оставляет панель и бота запущенными', async () => {
    vi.mocked(discoverTailscaleAddress).mockRejectedValue(new Error('клиент Tailscale не подключён'));
    app = await startApp({ envPath, port: 0, inheritProcessEnv: false, botFactory: factory });
    expect(await pairingAvailable()).toBe(false);
    expect(app.runtime.bot).not.toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('не подключён'));
  });

  it('занятый порт удалённого API не запускает fallback и оставляет панель и бота запущенными', async () => {
    const port = await occupy('::1');
    const listen = useLoopbackForTailscale();
    app = await startApp({ envPath, port, fallbackPort: true, inheritProcessEnv: false, botFactory: factory });
    expect(app.panel!.port).toBe(port);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(await pairingAvailable()).toBe(false);
    expect(app.runtime.bot).not.toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'));
  });

  it('при отказе клиента во время работы закрывает удалённый слушатель', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      useLoopbackForTailscale();
      app = await startApp({ envPath, port: 0, inheritProcessEnv: false, botFactory: factory });
      const port = app.panel!.port;
      vi.mocked(discoverTailscaleAddress).mockRejectedValue(new Error('клиент Tailscale не подключён'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pairingAvailable()).toBe(false);
      await expect(once(createConnection(port, '::1'), 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(app.runtime.bot).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
