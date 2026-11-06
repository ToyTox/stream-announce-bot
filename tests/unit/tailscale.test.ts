import type { ExecFileOptions } from 'node:child_process';
import type { NetworkInterfaceInfo } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverTailscaleAddress, tailscaleAddressAssigned } from '../../src/web/tailscale.js';

const { execFile, networkInterfaces, platform } = vi.hoisted(() => ({
  execFile: vi.fn<(file: string, args: string[], options: ExecFileOptions, callback: (error: Error | null, stdout?: string) => void) => void>(),
  networkInterfaces: vi.fn<() => Record<string, NetworkInterfaceInfo[]>>(),
  platform: vi.fn<() => NodeJS.Platform>(),
}));
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('node:os', () => ({ networkInterfaces, platform }));

const address = '100.100.10.20';
const addresses = [address, 'fd7a:115c:a1e0::1'];

function entry(ip = address, internal = false): NetworkInterfaceInfo {
  return { address: ip, internal, family: 'IPv4', netmask: '255.255.255.255', mac: '00:00:00:00:00:00', cidr: `${ip}/32` };
}

function status(overrides: Record<string, unknown> = {}) {
  const json = { BackendState: 'Running', TailscaleIPs: addresses, Self: { TailscaleIPs: [...addresses, ...addresses] }, ...overrides };
  execFile.mockImplementation((_file, _args, _options, cb) => cb(null, JSON.stringify(json)));
}

beforeEach(() => {
  execFile.mockReset();
  platform.mockReturnValue('darwin');
  networkInterfaces.mockReturnValue({ utun4: [entry()] });
  status();
});

afterEach(() => vi.unstubAllEnvs());

describe('обнаружение адреса Tailscale', () => {
  it('запускает CLI из стандартного пакета macOS без терминального PATH', async () => {
    vi.stubEnv('PATH', '');
    expect(await discoverTailscaleAddress()).toEqual({ address, interfaceName: 'utun4' });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      ['status', '--json', '--peers=false'],
      expect.objectContaining({ env: expect.objectContaining({ TAILSCALE_BE_CLI: '1', PATH: '' }), timeout: 3000 }),
      expect.any(Function)
    );
  });

  it('ищет launcher macOS Standalone, если пакет отсутствует', async () => {
    execFile.mockImplementationOnce((_file, _args, _options, cb) => cb(Object.assign(new Error(), { code: 'ENOENT' })));
    expect(await discoverTailscaleAddress()).toEqual({ address, interfaceName: 'utun4' });
    expect(execFile.mock.calls.map(([file]) => file)).toEqual(['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale']);
  });

  it('на Windows использует абсолютный системный путь и скрывает окно CLI', async () => {
    platform.mockReturnValue('win32');
    networkInterfaces.mockReturnValue({ Tailscale: [entry()] });
    vi.stubEnv('PATH', '');
    vi.stubEnv('ProgramW6432', 'D:\\Program Files');
    expect(await discoverTailscaleAddress()).toEqual({ address, interfaceName: 'Tailscale' });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      'D:\\Program Files\\Tailscale\\tailscale.exe',
      ['status', '--json', '--peers=false'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function)
    );
  });

  it.each(['Stopped', 'NeedsLogin', 'Starting', undefined])('не доверяет адресу при состоянии %s', async (BackendState) => {
    status({ BackendState });
    await expect(discoverTailscaleAddress()).rejects.toThrow('не подключён');
  });

  it.each([
    { Self: { TailscaleIPs: ['100.100.10.21'] } },
    { TailscaleIPs: [], Peer: { other: { TailscaleIPs: addresses } } },
    { TailscaleIPs: [...addresses, '100.100.10.21'] },
    { Self: { TailscaleIPs: [...addresses, '100.100.10.21'] } },
    { TailscaleIPs: ['192.168.1.2'], Self: { TailscaleIPs: ['192.168.1.2'] } },
    { TailscaleIPs: ['100.128.0.1'], Self: { TailscaleIPs: ['100.128.0.1'] } },
    { TailscaleIPs: ['100.100.100.100'], Self: { TailscaleIPs: ['100.100.100.100'] } },
    { TailscaleIPs: [address, 'not an IP'] },
  ])('отклоняет статус без однозначного адреса узла (%j)', async (overrides) => {
    status(overrides);
    await expect(discoverTailscaleAddress()).rejects.toThrow('не подтвердил единственный IPv4-адрес');
  });

  it.each([
    {},
    { en0: [entry()] },
    { utun4: [entry('100.100.10.21')] },
    { utun4: [entry(address, true)] },
    { utun4: [entry()], en0: [entry()] },
  ])('отклоняет неназначенный, непригодный или неоднозначный локальный адрес (%j)', async (interfaces) => {
    networkInterfaces.mockReturnValue(interfaces as Record<string, NetworkInterfaceInfo[]>);
    await expect(discoverTailscaleAddress()).rejects.toThrow('локальном интерфейсе Tailscale');
  });

  it('при повторной проверке требует тот же локальный интерфейс', async () => {
    const node = await discoverTailscaleAddress();
    expect(tailscaleAddressAssigned(node)).toBe(true);
    networkInterfaces.mockReturnValue({ utun5: [entry()] });
    expect(tailscaleAddressAssigned(node)).toBe(false);
  });

  it('отличает отсутствие клиента от его сбоя, не раскрывая вывод CLI', async () => {
    execFile.mockImplementation((_file, _args, _options, cb) => cb(Object.assign(new Error('secret'), { code: 'ENOENT' })));
    await expect(discoverTailscaleAddress()).rejects.toThrow('не найден');
    execFile.mockImplementation((_file, _args, _options, cb) => cb(new Error('secret')));
    await expect(discoverTailscaleAddress()).rejects.toThrow(/^клиент Tailscale не вернул статус$/);
    execFile.mockImplementation((_file, _args, _options, cb) => cb(null, 'secret'));
    await expect(discoverTailscaleAddress()).rejects.toThrow(/^клиент Tailscale вернул нечитаемый статус$/);
  });
});
