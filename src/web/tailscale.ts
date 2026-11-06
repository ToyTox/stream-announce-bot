import { execFile } from 'node:child_process';
import { isIP, isIPv4 } from 'node:net';
import { networkInterfaces, platform } from 'node:os';
import { win32 } from 'node:path';

export interface TailscaleAddress {
  address: string;
  interfaceName: string;
}

function commands(): string[] {
  switch (platform()) {
    case 'darwin':
      return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'];
    case 'win32': {
      const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'];
      return [...new Set(roots.flatMap((root) => root && /^[a-z]:[\\/]/i.test(root) ? [win32.join(root, 'Tailscale', 'tailscale.exe')] : []))];
    }
    case 'linux':
      return ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
    default:
      return [];
  }
}

async function readStatus(signal?: AbortSignal): Promise<string> {
  for (const command of commands()) {
    try {
      return await new Promise<string>((resolve, reject) => {
        execFile(command, ['status', '--json', '--peers=false'], {
          encoding: 'utf8',
          env: { ...process.env, TAILSCALE_BE_CLI: '1' },
          signal,
          timeout: 3000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('клиент Tailscale не вернул статус');
      }
    }
  }
  throw new Error('CLI Tailscale не найден в стандартных путях установки');
}

function singleIPv4(ips: unknown): string | undefined {
  if (!Array.isArray(ips) || !ips.every((ip) => typeof ip === 'string' && isIP(ip))) return undefined;
  const addresses = [...new Set<string>(ips.filter(isIPv4))];
  return addresses.length === 1 ? addresses[0] : undefined;
}

function tunnelInterface(address: string): string | undefined {
  const matches = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? []).filter((entry) => entry.family === 'IPv4' && entry.address === address).map((entry) => ({ name, entry }))
  );
  const match = matches[0];
  if (matches.length !== 1 || !match || match.entry.internal) return undefined;

  const os = platform();
  if (os === 'darwin' && /^utun\d+$/.test(match.name)) return match.name;
  if (os === 'win32' && /^Tailscale$/i.test(match.name)) return match.name;
  if (os === 'linux' && match.name === 'tailscale0') return match.name;
  return undefined;
}

export function tailscaleAddressAssigned(current: TailscaleAddress): boolean {
  try {
    return tunnelInterface(current.address) === current.interfaceName;
  } catch {
    return false;
  }
}

export async function discoverTailscaleAddress(signal?: AbortSignal): Promise<TailscaleAddress> {
  const output = await readStatus(signal);
  let status: { BackendState?: unknown; TailscaleIPs?: unknown; Self?: { TailscaleIPs?: unknown } } | null;
  try {
    status = JSON.parse(output);
  } catch {
    throw new Error('клиент Tailscale вернул нечитаемый статус');
  }
  if (status?.BackendState !== 'Running') throw new Error('клиент Tailscale не подключён');

  const address = singleIPv4(status.TailscaleIPs);
  const secondOctet = Number(address?.split('.')[1]);
  if (!address || address !== singleIPv4(status.Self?.TailscaleIPs) || !address.startsWith('100.') ||
      secondOctet < 64 || secondOctet > 127 || address === '100.100.100.100') {
    throw new Error('клиент Tailscale не подтвердил единственный IPv4-адрес узла');
  }

  let interfaceName: string | undefined;
  try {
    interfaceName = tunnelInterface(address);
  } catch {
    throw new Error('не удалось проверить локальные сетевые интерфейсы');
  }
  if (!interfaceName) throw new Error('адрес узла отсутствует на локальном интерфейсе Tailscale или неоднозначен');
  return { address, interfaceName };
}
