import * as SecureStore from 'expo-secure-store';
import { createCredentialsStore } from '../src/credentials';

const credentials = { apiUrl: 'https://bot.example/api/v1', token: 'B'.repeat(43) };
const get = jest.mocked(SecureStore.getItemAsync);
const set = jest.mocked(SecureStore.setItemAsync);
const remove = jest.mocked(SecureStore.deleteItemAsync);

afterEach(() => jest.useRealTimers());

describe('защищённое хранилище подключения', () => {
  it('сохраняет адрес с токеном, восстанавливает новым клиентом и удаляет', async () => {
    let record: string | null = null;
    get.mockImplementation(async () => record);
    set.mockImplementation(async (_key, value) => { record = value; });
    remove.mockImplementation(async () => { record = null; });
    await createCredentialsStore().save(credentials);
    expect(set).toHaveBeenCalledWith('bot-connection-v1', JSON.stringify({ format: 1, ...credentials }), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY, requireAuthentication: false,
    });
    const restored = createCredentialsStore();
    await expect(restored.read()).resolves.toEqual(credentials);
    await restored.remove();
    await expect(createCredentialsStore().read()).resolves.toBeNull();
    expect(remove.mock.calls[0]?.[0]).toBe(set.mock.calls[0]?.[0]);
  });

  it('отсутствие записи не означает ошибку', async () => {
    await expect(createCredentialsStore().read()).resolves.toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it.each(['', '{', 'null', '[]', '{}', JSON.stringify({ format: 2, ...credentials }),
    JSON.stringify({ format: 1, ...credentials, token: 'short' }),
    JSON.stringify({ format: 1, ...credentials, apiUrl: 'https://bot.example/api/v1?secret' })])('повреждённая запись %s не используется', async (raw) => {
    get.mockResolvedValue(raw);
    await expect(createCredentialsStore().read()).rejects.toMatchObject({ operation: 'read', damaged: true });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(['read', 'write', 'delete'] as const)('ошибка %s не даёт ложного успеха и не раскрывает секрет', async (operation) => {
    const logs = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
    const native = operation === 'read' ? get : operation === 'write' ? set : remove;
    native.mockRejectedValue(new Error(credentials.token));
    const store = createCredentialsStore();
    const result = operation === 'read' ? store.read() : operation === 'write' ? store.save(credentials) : store.remove();
    const error: unknown = await result.catch((value: unknown) => value);
    expect(error).toMatchObject({ operation });
    expect(String(error)).not.toContain(credentials.token);
    expect(JSON.stringify(error)).not.toContain(credentials.token);
    expect((error as Error).stack).not.toContain(credentials.token);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('не сохраняет непригодные данные', async () => {
    await expect(createCredentialsStore().save({ ...credentials, token: '' })).rejects.toMatchObject({ operation: 'write' });
    expect(set).not.toHaveBeenCalled();
  });

  it.each(['read', 'write', 'delete'] as const)('ограничивает зависшую операцию %s', async (operation) => {
    jest.useFakeTimers();
    const store = createCredentialsStore();
    if (operation === 'read') get.mockImplementation(() => new Promise(() => {}));
    if (operation === 'write') set.mockImplementation(() => new Promise(() => {}));
    if (operation === 'delete') remove.mockImplementation(() => new Promise(() => {}));
    const pending = operation === 'read' ? store.read() : operation === 'write' ? store.save(credentials) : store.remove();
    const result = expect(pending).rejects.toMatchObject({ operation });
    await jest.advanceTimersByTimeAsync(5000);
    await result;
  });

  it('удаление ждёт незавершённую запись и не даёт ей воскресить токен', async () => {
    let complete: () => void = () => {};
    set.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const store = createCredentialsStore();
    const saving = store.save(credentials);
    const deleting = store.remove();
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
    complete();
    await saving;
    await deleting;
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
