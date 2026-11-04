import jsQrModule from 'jsqr';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { PairingCodes, PAIRING_TTL_MS } from '../../src/devices.js';
import { pairingApiAddress, pairingQr } from '../../src/web/pairingQr.js';

const jsQR = jsQrModule as unknown as typeof import('jsqr').default;

describe('QR сопряжения', () => {
  it('изображение независимо читается и содержит действующий одноразовый код, адрес и версию', async () => {
    const codes = new PairingCodes();
    const issued = codes.issue(1000);
    const dataUrl = await pairingQr('http://100.100.10.20:3210/api/v1', issued);
    const png = PNG.sync.read(Buffer.from(dataUrl!.split(',')[1]!, 'base64'));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    const payload = JSON.parse(decoded!.data);

    expect(payload).toEqual({ type: 'stream-announce-bot/pair', apiVersion: 1, apiUrl: 'http://100.100.10.20:3210/api/v1', ...issued });
    expect(payload.expiresAt).toBe(1000 + PAIRING_TTL_MS);
    expect(decoded!.data).not.toMatch(/token|hash/i);
    expect(codes.redeem(payload.code, payload.expiresAt - 1)).toBe(true);
    expect(codes.redeem(payload.code, payload.expiresAt - 1)).toBe(false);
    expect(png.width).toBeGreaterThan(300);
    expect([...png.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  it.each([undefined, '', 'http://localhost:3210/api/v1', 'http://127.1/api/v1', 'http://[::1]/api/v1', 'http://0.0.0.0/api/v1', 'https://a:secret@example.org/api/v1', 'https://example.org/api/v1?code=x', 'https://example.org/api/v1#x', 'file:///api/v1', 'not a url'])('без доверенного достижимого адреса не создаёт QR: %s', async (address) => {
    expect(pairingApiAddress(address)).toBeUndefined();
    expect(await pairingQr(address, { code: 'A'.repeat(22), expiresAt: 5000 })).toBeUndefined();
  });
});
