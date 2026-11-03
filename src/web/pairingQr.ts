import QRCode from 'qrcode';

/** Адрес поставляет доверенный транспорт, а не браузер или настройки пользователя. */
export function pairingApiAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  try {
    const url = new URL(address);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/api/v1' || host === 'localhost' || host.endsWith('.localhost') ||
        host.startsWith('127.') || host === '[::1]' || host === '0.0.0.0' || host === '[::]') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** QR-контракт v1: JSON с типом, версией API, базовым адресом, кодом и сроком (Unix ms). */
export async function pairingQr(address: string | undefined, issued: { code: string; expiresAt: number }): Promise<string | undefined> {
  const apiUrl = pairingApiAddress(address);
  if (!apiUrl) return undefined;
  const payload = JSON.stringify({ type: 'stream-announce-bot/pair', apiVersion: 1, apiUrl, code: issued.code, expiresAt: issued.expiresAt });
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 4, scale: 6, color: { dark: '#000000ff', light: '#ffffffff' } });
}
