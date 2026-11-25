import { ApiError, createApiClient } from '../src/api';

const credentials = { apiUrl: 'https://bot.example/api/v1', token: 'A'.repeat(43) };

function response(data: unknown, status = 200, retryAfter: string | null = null): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => retryAfter }, json: async () => data } as unknown as Response;
}

afterEach(() => jest.useRealTimers());

describe('клиент API', () => {
  it('передаёт токен только заголовком и принимает пустую версию приложения', async () => {
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({ apiVersion: 1, version: '' }));
    await expect(createApiClient(credentials).checkConnection()).resolves.toEqual({ apiVersion: 1, version: '' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(`${credentials.apiUrl}/info`, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${credentials.token}` },
      signal: expect.any(AbortSignal), redirect: 'error',
    });
    expect(request.mock.calls[0]?.[0]).not.toContain(credentials.token);
    expect(request.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it.each(['http://bot.example/api/v1', 'https://bot.example:8443/api/v1'])('принимает адрес %s', async (apiUrl) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({ apiVersion: 1, version: '99.0' }));
    await expect(createApiClient({ ...credentials, apiUrl }).checkConnection()).resolves.toMatchObject({ apiVersion: 1 });
  });

  it.each(['bot.example', 'file:///api/v1', 'https://user:secret@bot.example/api/v1',
    'https://bot.example', 'https://bot.example/api/v2', 'https://bot.example/api/v1?token=secret',
    'https://bot.example/api/v1#secret', ' https://bot.example/api/v1', 'https://bot.example/api/v1?'])('отвергает адрес до сети: %s', (apiUrl) => {
    const request = jest.spyOn(globalThis, 'fetch');
    expect(() => createApiClient({ ...credentials, apiUrl })).toThrow(new ApiError('address'));
    expect(request).not.toHaveBeenCalled();
  });

  it('отвергает токен с неверным форматом до сети', () => {
    const request = jest.spyOn(globalThis, 'fetch');
    expect(() => createApiClient({ ...credentials, token: 'secret\r\nHeader: value' })).toThrow(new ApiError('authorization'));
    expect(request).not.toHaveBeenCalled();
  });

  it.each([[401, 'authorization'], [403, 'forbidden'], [429, 'rate-limit'], [500, 'http'], [404, 'http'], [302, 'http']])('отличает HTTP %s', async (status, kind) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({ error: credentials.token }, Number(status)));
    await expect(createApiClient(credentials).checkConnection()).rejects.toMatchObject({ kind, status });
  });

  it.each([null, {}, [], { apiVersion: '1', version: '' }, { apiVersion: 0, version: '' },
    { apiVersion: 1.5, version: '' }, { apiVersion: 1 }, { apiVersion: 1, version: null }])('отличает повреждённую структуру %p', async (data) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response(data));
    await expect(createApiClient(credentials).checkConnection()).rejects.toMatchObject({ kind: 'response' });
  });

  it('отличает неизвестную версию API от структуры и версии приложения', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({ apiVersion: 2, version: '1.0' }));
    await expect(createApiClient(credentials).checkConnection()).rejects.toMatchObject({ kind: 'incompatible' });
  });

  it('обрабатывает повреждённый JSON', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ...response(null), json: async () => { throw new Error(credentials.token); } } as Response);
    await expect(createApiClient(credentials).checkConnection()).rejects.toMatchObject({ kind: 'response' });
  });

  it.each(['seconds', 'date'] as const)('учитывает Retry-After (%s) без автоматического повтора', async (format) => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    const retryAfter = format === 'seconds' ? '12' : new Date(Date.now() + 12000).toUTCString();
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 429, retryAfter));
    await expect(createApiClient(credentials).checkConnection()).rejects.toMatchObject({ kind: 'rate-limit', retryAt: Date.now() + 12000 });
    await jest.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('не доверяет произвольному Retry-After', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 429, credentials.token));
    await expect(createApiClient(credentials).checkConnection()).rejects.toMatchObject({ kind: 'rate-limit', retryAt: undefined });
  });

  it.each(['headers', 'body'] as const)('ограничивает ожидание %s, даже если транспорт не реагирует на отмену', async (stage) => {
    jest.useFakeTimers();
    const pending = new Promise<Response>(() => {});
    const request = jest.spyOn(globalThis, 'fetch').mockImplementation(() => stage === 'headers' ? pending :
      Promise.resolve({ ...response(null), json: () => new Promise(() => {}) } as Response));
    const result = createApiClient(credentials, 100).checkConnection();
    const assertion = expect(result).rejects.toMatchObject({ kind: 'unavailable' });
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([false, true])('отмена (заранее: %s) завершает ожидание безопасно', async (alreadyAborted) => {
    const request = jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const result = createApiClient(credentials).checkConnection(controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ kind: 'cancelled' });
    expect(request).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1);
  });

  it('потеря сети не раскрывает исходную ошибку или токен и ничего не пишет в лог', async () => {
    const logs = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`transport ${credentials.token}`));
    const error = await createApiClient(credentials).checkConnection().catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: 'unavailable' });
    expect(String(error)).not.toContain(credentials.token);
    expect(JSON.stringify(error)).not.toContain(credentials.token);
    expect((error as Error).stack).not.toContain(credentials.token);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
