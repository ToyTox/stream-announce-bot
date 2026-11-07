import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request, Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import jsQrModule from 'jsqr';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db.js';
import { DeviceStore } from '../../src/devices.js';
import { messagesFor, t, type Lang } from '../../src/i18n/index.js';
import { createPanel } from '../../src/web/server.js';
import { discoverTailscaleAddress, tailscaleAddressAssigned } from '../../src/web/tailscale.js';

const jsQR = jsQrModule as unknown as typeof import('jsqr').default;
const tailscaleIp = '100.100.10.20';
vi.mock('../../src/web/tailscale.js');

/** Выполняем настоящий блок интерфейса в VM; HTTP и временная база настоящие, DOM минимальный. */
class Element {
  children: Element[] = [];
  textContent = '';
  hidden = false;
  disabled = false;
  src = '';
  alt = '';
  className = '';
  focused = false;
  attributes: Record<string, string> = {};
  listeners: Record<string, (event?: any) => unknown> = {};
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren(...elements: Element[]) { this.children = elements; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; delete this.attributes[name]; }
  addEventListener(name: string, callback: (event?: any) => unknown) { this.listeners[name] = callback; }
  querySelectorAll(_selector: string): Element[] { return this.children.flatMap((child) => [child, ...child.querySelectorAll(_selector)]).filter((node) => node.listeners.click); }
  focus() { this.focused = true; }
  async click() { if (!this.disabled) await this.listeners.click?.(); }
}

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const block = html.split('  // ---------- Телефоны и устройства ----------')[1]!.split('  // ---------- Лог ----------')[0]!;
let dir: string;
let db: Db;
let panel: ReturnType<typeof createPanel>;
let base: string;
let trustedAddress: string | undefined;
let lang: Lang;
let now: number;
let elements: Record<string, Element>;
let tick: () => Promise<void>;
let calls: string[];
let intercept: ((method: string, path: string, body?: unknown) => Promise<unknown> | undefined) | undefined;
let ui: { issuePairing(): Promise<void>; loadDevices(): Promise<void>; closePairing(): void; renderPairing(): void };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'panel-devices-ui-'));
  db = openDb(join(dir, 'bot.db'));
  trustedAddress = undefined;
  lang = 'ru';
  now = Date.now();
  calls = [];
  intercept = undefined;
  panel = createPanel({ runtime: { bot: null, configError: null, restart: vi.fn() }, env: { DATABASE_PATH: join(dir, 'bot.db') }, envPath: join(dir, '.env') });
  await new Promise<void>((resolve) => panel.server.listen(0, '127.0.0.1', resolve));
  panel.port = (panel.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${panel.port}`;
  elements = {};
  for (const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) {
    const node = new Element();
    node.hidden = /\bhidden\b/.test(match[0]);
    elements[match[1]!] = node;
  }
  const context = createContext({
    $: (id: string) => elements[id],
    document: { createElement: () => new Element() },
    t: (key: string, params?: Record<string, string>) => t(lang, key, params),
    dateTime: (ms: number) => new Date(ms).toLocaleString(messagesFor(lang).locale),
    Date: class extends Date { static now() { return now; } },
    loaders: {},
    setInterval: (callback: () => Promise<void>) => { tick = callback; },
    api: async (method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}`);
      const result = intercept?.(method, path, body);
      if (result) return result;
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'accept-language': lang }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      return data;
    },
  });
  ui = runInContext(`${block}\n({ issuePairing, loadDevices, closePairing, renderPairing })`, context);
});

afterEach(async () => {
  await panel.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function el(id: string) { return elements[id]!; }
function decodeQr(): any {
  const png = PNG.sync.read(Buffer.from(el('pairing-qr').src.split(',')[1]!, 'base64'));
  return JSON.parse(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)!.data);
}

async function enableRemote() {
  vi.mocked(discoverTailscaleAddress).mockResolvedValue({ address: tailscaleIp, interfaceName: 'utun4' });
  vi.mocked(tailscaleAddressAssigned).mockReturnValue(true);
  const listen = HttpServer.prototype.listen;
  vi.spyOn(HttpServer.prototype, 'listen').mockImplementation(function (this: HttpServer, ...args: unknown[]) {
    if (args[1] === tailscaleIp) args[1] = '::1';
    return Reflect.apply(listen, this, args);
  });
  await panel.startRemote();
  trustedAddress = `http://${tailscaleIp}:${panel.port}/api/v1`;
}

function pairRemotely(code: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '::1', port: panel.port, path: '/api/v1/pair', method: 'POST',
      headers: { host: `${tailscaleIp}:${panel.port}`, 'content-type': 'application/json' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ code, name: 'Pixel' }));
  });
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('панель: интерфейс устройств', () => {
  it('честная недоступность не выпускает код и не показывает localhost, доступна клавиатура', async () => {
    await el('pairing-open').click();
    expect(calls).toEqual(['GET /api/pairing']);
    expect(el('pairing-status').textContent).toContain('REMOTE_ENABLED=true');
    expect(el('pairing-details').hidden).toBe(true);
    expect(el('pairing-qr').src).toBe('');
    expect(el('pairing-renew').hidden).toBe(true);
    expect(el('pairing-close').focused).toBe(true);
    el('pairing-panel').listeners.keydown!({ key: 'Escape' });
    expect(el('pairing-panel').hidden).toBe(true);
    expect(el('pairing-open').focused).toBe(true);
    lang = 'en';
    await ui.issuePairing();
    expect(el('pairing-status').textContent).toContain('check the logs');
  });

  it('сканируемый QR с фактическим портом, повторный выпуск, срок и одноразовый обмен через удалённый вход', async () => {
    await enableRemote();
    await ui.issuePairing();
    const first = decodeQr();
    expect(first.apiUrl).toBe(trustedAddress);
    expect(first.apiVersion).toBe(1);
    expect(first.expiresAt - Date.now()).toBeGreaterThan(290000);
    expect(el('pairing-address').textContent).toBe(trustedAddress);
    expect(el('pairing-details').hidden).toBe(false);
    expect(el('pairing-expires').textContent).toBe(t('ru', 'ui.pairing.expires', { seconds: Math.ceil((first.expiresAt - now) / 1000) }));
    await el('pairing-renew').click();
    const second = decodeQr();
    expect(await pairRemotely(first.code)).toBe(401);
    expect(await pairRemotely(second.code)).toBe(200);
    expect(await pairRemotely(second.code)).toBe(401);
    lang = 'en';
    ui.renderPairing();
    expect(el('pairing-expires').textContent).toContain('Expires in');
    expect(el('pairing-qr').alt).toBe('Phone pairing QR code');
    now = second.expiresAt;
    await tick();
    expect(el('pairing-details').hidden).toBe(true);
    expect(el('pairing-qr').src).toBe('');
    expect(el('pairing-status').textContent).toContain('expired');
    expect(el('pairing-renew').hidden).toBe(false);
  });

  it('утрата подтверждённого адреса скрывает показанный QR и исключает новый выпуск из интерфейса', async () => {
    await enableRemote();
    await ui.issuePairing();
    expect(decodeQr().apiUrl).toBe(trustedAddress);
    vi.mocked(tailscaleAddressAssigned).mockReturnValue(false);

    await tick();
    expect(el('pairing-details').hidden).toBe(true);
    expect(el('pairing-address').textContent).toBe('');
    expect(el('pairing-qr').src).toBe('');
    expect(el('pairing-renew').hidden).toBe(true);
    expect(el('pairing-status').textContent).toContain('REMOTE_ENABLED=true');
    await expect(pairRemotely('invalid')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    ui.closePairing();
    calls.length = 0;
    await ui.issuePairing();
    expect(calls).toEqual(['GET /api/pairing']);
  });

  it('утрата адреса между проверкой и выпуском QR сохраняет действующий локальный код', async () => {
    await enableRemote();
    const { code } = await (await fetch(`${base}/api/pairing`, { method: 'POST', headers: { 'content-type': 'application/json' } })).json();
    intercept = (method) => {
      if (method === 'POST') vi.mocked(tailscaleAddressAssigned).mockReturnValue(false);
      return undefined;
    };
    await ui.issuePairing();
    expect(el('pairing-qr').src).toBe('');
    const paired = await fetch(`${base}/api/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Pixel' }),
    });
    expect(paired.status).toBe(200);
  });

  it('закрытие отбрасывает запоздалый QR, повторный клик не создаёт второй запрос', async () => {
    await enableRemote();
    const pending = deferred<unknown>();
    intercept = (method) => method === 'POST' ? pending.promise : undefined;
    const opening = ui.issuePairing();
    while (!calls.includes('POST /api/pairing?qr=true')) await new Promise((resolve) => setTimeout(resolve, 1));
    await ui.issuePairing();
    expect(calls.filter((call) => call === 'GET /api/pairing')).toHaveLength(1);
    ui.closePairing();
    expect(el('pairing-qr').src).toBe('');
    intercept = undefined;
    await ui.issuePairing();
    const freshQr = el('pairing-qr').src;
    pending.resolve({ apiUrl: trustedAddress, qrDataUrl: 'data:image/png;base64,old', expiresAt: now + 5000 });
    await opening;
    expect(el('pairing-panel').hidden).toBe(false);
    expect(el('pairing-qr').src).toBe(freshQr);
  });

  it('старый ответ списка и старая ошибка не заменяют новый список', async () => {
    const old = deferred<unknown>();
    intercept = () => old.promise;
    const loading = ui.loadDevices();
    intercept = undefined;
    new DeviceStore(db).issue('New');
    await ui.loadDevices();
    old.resolve({ devices: [] });
    await loading;
    expect(el('devices-list').children[0]!.children[0]!.textContent).toBe('New');
    const failed = deferred<unknown>();
    intercept = () => failed.promise;
    const failing = ui.loadDevices();
    intercept = undefined;
    await ui.loadDevices();
    failed.reject(new Error('old error'));
    await failing;
    expect(el('devices-status').textContent).toBe('');
  });

  it('пустой список, безопасное имя и отзыв обновляют состояние, язык меняет подписи', async () => {
    await ui.loadDevices();
    expect(el('devices-status').textContent).toBe(t('ru', 'ui.devices.empty'));
    const name = '<img src=x onerror=alert(1)>';
    const issued = new DeviceStore(db).issue(name);
    await ui.loadDevices();
    const row = el('devices-list').children[0]!;
    expect(row.children[0]!.textContent).toBe(name);
    expect(row.children[0]!.children).toEqual([]);
    const button = row.children[3]!;
    await button.click();
    expect(el('devices-list').children[0]!.children).toHaveLength(3);
    expect(el('devices-list').children[0]!.children[2]!.textContent).toContain('Отключено');
    expect(new DeviceStore(db).findByToken(issued.token)).toBeUndefined();
    expect(el('devices-status').textContent).toBe(t('ru', 'ui.devices.disconnected'));
    expect(el('devices-refresh').focused).toBe(true);
    lang = 'en';
    await ui.loadDevices();
    expect(el('devices-list').children[0]!.children[2]!.textContent).toContain('Disconnected');
  });

  it('ошибки загрузки, выпуска и отзыва допускают повторную попытку', async () => {
    intercept = () => Promise.reject(new Error('Network error'));
    await ui.loadDevices();
    expect(el('devices-status').textContent).toBe('Network error');
    expect(el('devices-refresh').disabled).toBe(false);
    await ui.issuePairing();
    expect(el('pairing-status').textContent).toBe('Network error');
    expect(el('pairing-renew').disabled).toBe(false);
    await tick();
    expect(el('pairing-status').textContent).toBe('Network error');
    await enableRemote();
    intercept = (method) => method === 'POST' ? Promise.reject(new Error('QR failed')) : undefined;
    await el('pairing-renew').click();
    expect(el('pairing-status').textContent).toBe('QR failed');
    expect(el('pairing-qr').src).toBe('');
    await tick();
    expect(el('pairing-status').textContent).toBe('QR failed');
    intercept = undefined;
    await el('pairing-renew').click();
    expect(decodeQr().apiUrl).toBe(trustedAddress);
    expect(el('pairing-status').textContent).toBe(t('ru', 'ui.pairing.scan'));
    await tick();
    expect(el('pairing-status').textContent).toBe(t('ru', 'ui.pairing.scan'));
    new DeviceStore(db).issue('Pixel');
    await ui.loadDevices();
    intercept = (method) => method === 'POST' ? Promise.reject(new Error('Revoke failed')) : undefined;
    await el('devices-list').children[0]!.children[3]!.click();
    expect(el('devices-status').textContent).toBe('Revoke failed');
    expect(el('devices-list').children[0]!.children[3]!.disabled).toBe(false);
    intercept = undefined;
    await el('devices-list').children[0]!.children[3]!.click();
    expect(el('devices-list').children[0]!.children).toHaveLength(3);
  });
});
