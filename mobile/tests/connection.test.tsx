import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import * as SecureStore from 'expo-secure-store';
import { Button, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConnectionProvider, useConnection } from '../src/connection';
import { ConnectionGate } from '../src/screens';

const credentials = { apiUrl: 'https://bot.example/api/v1', token: 'E'.repeat(43) };
const other = { apiUrl: 'https://other.example/api/v1', token: 'F'.repeat(43) };
const get = jest.mocked(SecureStore.getItemAsync);

function response(data: unknown = { apiVersion: 1, version: '' }, status = 200, retryAfter: string | null = null): Response {
  return { ok: status === 200, status, headers: { get: () => retryAfter }, json: async () => data } as unknown as Response;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function Controls() {
  const { state, retry, forget, connect } = useConnection();
  return <>
    <Text testID="state">{state.kind}</Text>
    <Button title="Сохранить первое" onPress={() => connect(credentials)} />
    <Button title="Сохранить второе" onPress={() => connect(other)} />
    <Button title="Повторить проверку" onPress={retry} />
    <Button title="Забыть" onPress={forget} />
    <ConnectionGate><Text>Разделы приложения</Text></ConnectionGate>
  </>;
}

async function open() {
  return render(<SafeAreaProvider><NavigationContainer><ConnectionProvider><Controls /></ConnectionProvider></NavigationContainer></SafeAreaProvider>);
}

afterEach(() => jest.useRealTimers());

describe('подключение при запуске', () => {
  it('без записи оставляет разделы доступными и не обращается к сети', async () => {
    const request = jest.spyOn(globalThis, 'fetch');
    await open();
    expect(screen.getByTestId('state')).toHaveTextContent('empty');
    expect(screen.getByText('Разделы приложения')).toBeOnTheScreen();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [401, { error: credentials.token }, 'Токен не принят'],
    [403, {}, 'Доступ запрещён'],
    [429, {}, 'Слишком много запросов'],
    [500, {}, 'Ошибка API'],
    [200, { apiVersion: 2, version: '' }, 'Несовместимая версия API'],
    [200, { apiVersion: '1', version: '' }, 'Некорректный ответ API'],
  ])('показывает понятное состояние ответа %s %p', async (status, data, title) => {
    get.mockResolvedValue(JSON.stringify({ format: 1, ...credentials }));
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response(data, Number(status)));
    await open();
    expect(await screen.findByRole('header', { name: String(title) })).toBeOnTheScreen();
    expect(screen.queryByText('Разделы приложения')).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(JSON.stringify(screen.toJSON())).not.toContain(credentials.token);
  });

  it('показывает ограниченную загрузку и игнорирует повторы до завершения', async () => {
    jest.useFakeTimers();
    get.mockResolvedValue(JSON.stringify({ format: 1, ...credentials }));
    const request = jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    await open();
    expect(screen.getByRole('header', { name: 'Проверка подключения' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Повторить проверку' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Повторить проверку' }));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(10000); });
    expect(screen.getByRole('header', { name: 'Бот недоступен' })).toBeOnTheScreen();
  });

  it('соблюдает ожидание повторной попытки и восстанавливается после 429', async () => {
    jest.useFakeTimers();
    get.mockResolvedValue(JSON.stringify({ format: 1, ...credentials }));
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({}, 429, '2')).mockResolvedValue(response());
    await open();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Повторить проверку' }));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
    await fireEvent.press(screen.getByRole('button', { name: 'Повторить' }));
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('ошибка чтения (повреждение: %s) даёт повтор или удаление без сети', async (damaged) => {
    if (damaged) get.mockResolvedValue(credentials.token);
    else get.mockRejectedValue(new Error(credentials.token));
    const request = jest.spyOn(globalThis, 'fetch');
    await open();
    expect(screen.getByRole('header', { name: 'Ошибка защищённого хранилища' })).toBeOnTheScreen();
    expect(JSON.stringify(screen.toJSON())).not.toContain(credentials.token);
    expect(request).not.toHaveBeenCalled();
    get.mockResolvedValue(null);
    await fireEvent.press(screen.getByRole('button', { name: 'Повторить' }));
    expect(screen.getByTestId('state')).toHaveTextContent('empty');
  });

  it('ошибка записи не сообщает успех и повторяет сохранение', async () => {
    const set = jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error(credentials.token));
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Сохранить первое' }));
    expect(screen.getByText('Не удалось подтвердить сохранение подключения. Повторите сохранение.')).toBeOnTheScreen();
    expect(request).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Повторить' }));
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('ошибка удаления сохраняет предупреждение и повторяет именно удаление', async () => {
    get.mockResolvedValue(JSON.stringify({ format: 1, ...credentials }));
    const remove = jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error(credentials.token));
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Забыть' }));
    expect(screen.getByText('Не удалось удалить токен. Он может оставаться на телефоне. Повторите удаление.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Повторить' }));
    expect(screen.getByTestId('state')).toHaveTextContent('empty');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('позднее чтение после удаления не восстанавливает токен', async () => {
    const reading = deferred<string | null>();
    get.mockReturnValue(reading.promise);
    const request = jest.spyOn(globalThis, 'fetch');
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Забыть' }));
    await act(async () => reading.resolve(JSON.stringify({ format: 1, ...credentials })));
    expect(screen.getByTestId('state')).toHaveTextContent('empty');
    expect(request).not.toHaveBeenCalled();
  });

  it('поздний ответ старого адреса не заменяет новое подключение', async () => {
    get.mockResolvedValue(JSON.stringify({ format: 1, ...credentials }));
    const old = deferred<Response>();
    const request = jest.spyOn(globalThis, 'fetch').mockReturnValueOnce(old.promise).mockResolvedValue(response());
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Сохранить второе' }));
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
    await act(async () => old.resolve(response({ apiVersion: 9, version: '' })));
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(request.mock.calls[1]?.[0]).toBe(`${other.apiUrl}/info`);
  });

  it('удаление во время запроса не даёт позднему успеху восстановить состояние', async () => {
    get.mockResolvedValue(JSON.stringify({ format: 1, ...credentials }));
    const pending = deferred<Response>();
    const request = jest.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise);
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Забыть' }));
    await act(async () => pending.resolve(response()));
    expect(screen.getByTestId('state')).toHaveTextContent('empty');
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('закрытие отменяет запрос и игнорирует поздний ответ', async () => {
    get.mockResolvedValue(JSON.stringify({ format: 1, ...credentials }));
    const pending = deferred<Response>();
    const request = jest.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise);
    const view = await open();
    await view.unmount();
    await act(async () => pending.resolve(response()));
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
