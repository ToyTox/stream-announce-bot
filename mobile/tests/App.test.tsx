import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { NavigationBar } from 'expo-navigation-bar';
import * as SecureStore from 'expo-secure-store';
import { Appearance, BackHandler, Platform } from 'react-native';
import App from '../App';

jest.mock('expo-navigation-bar', () => ({ NavigationBar: jest.fn(() => null) }));

type Scheme = ReturnType<typeof Appearance.getColorScheme>;
type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
type AppearanceListener = Parameters<typeof Appearance.addChangeListener>[0];

let scheme: Scheme;
let appearanceListeners: Set<AppearanceListener>;
let backListeners: Set<BackListener>;

beforeEach(() => {
  jest.mocked(NavigationBar).mockClear();
  scheme = 'light';
  appearanceListeners = new Set();
  backListeners = new Set();
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Appearance, 'getColorScheme').mockImplementation(() => scheme);
  jest.spyOn(Appearance, 'addChangeListener').mockImplementation((listener) => {
    appearanceListeners.add(listener);
    return { remove: () => { appearanceListeners.delete(listener); } };
  });
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, listener) => {
    backListeners.add(listener);
    return { remove: () => { backListeners.delete(listener); } };
  });
});

async function openSection(title: string) {
  await fireEvent.press(screen.getByLabelText(`Раздел «${title}»`));
  expect(screen.getByRole('header', { name: title })).toBeOnTheScreen();
  expect(screen.getByLabelText(`Раздел «${title}»`)).toBeSelected();
}

async function systemBack(): Promise<boolean> {
  let handled = false;
  await act(async () => {
    handled = [...backListeners].reverse().some((listener) => listener({ type: 'hardwareBackPress', timeStamp: 1 }) === true);
  });
  return handled;
}

describe('каркас приложения', () => {
  it('открывает сопряжение и все пять заглушок через настоящие вкладки', async () => {
    const request = jest.spyOn(globalThis, 'fetch');
    await render(<App />);

    expect(screen.getByRole('header', { name: 'Сопряжение' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Раздел «Сопряжение»')).toBeSelected();
    expect(screen.getByText('Здесь появятся сканирование кода, подключение к боту и отключение телефона.')).toBeOnTheScreen();

    const sections = [
      ['Статус', 'Здесь появятся состояние эфира, результаты проверок площадок и ошибки.'],
      ['Сообщение', 'Здесь появятся текст, картинка и предпросмотр анонса.'],
      ['Настройки', 'Здесь появятся основные настройки площадок, таймингов и тестового режима.'],
      ['Лог', 'Здесь появятся последние записи о работе бота.'],
    ] as const;

    for (const [title, description] of sections) {
      await openSection(title);
      expect(screen.getByText(description)).toBeOnTheScreen();
      expect(screen.getByText('Это каркас приложения. Рабочие действия появятся позже.')).toBeOnTheScreen();
    }

    await openSection('Сопряжение');
    expect(request).not.toHaveBeenCalled();
  });

  it('системный возврат проходит по истории разделов и отдаётся системе на старте', async () => {
    await render(<App />);
    expect(await systemBack()).toBe(false);

    await openSection('Статус');
    await openSection('Сообщение');
    await openSection('Настройки');
    await openSection('Лог');

    for (const title of ['Настройки', 'Сообщение', 'Статус', 'Сопряжение']) {
      expect(await systemBack()).toBe(true);
      expect(screen.getByRole('header', { name: title })).toBeOnTheScreen();
      expect(screen.getByLabelText(`Раздел «${title}»`)).toBeSelected();
    }

    expect(await systemBack()).toBe(false);
  });

  it.each([
    ['light', '#182333', '#2455a4', 'dark'],
    ['dark', '#edf2fa', '#a6c8ff', 'light'],
    [null, '#182333', '#2455a4', 'dark'],
  ] as const)('тема системы %s согласует текст, вкладку и системные кнопки', async (value, text, primary, barStyle) => {
    scheme = value;
    await render(<App />);

    expect(screen.getByRole('header', { name: 'Сопряжение' })).toHaveStyle({ color: text });
    expect(screen.getAllByText('1', { includeHiddenElements: true })[0]).toHaveStyle({ color: primary });
    expect(jest.mocked(NavigationBar).mock.lastCall?.[0].style).toBe(barStyle);
  });

  it('меняет тему при открытом приложении, сохраняет раздел и историю возврата', async () => {
    await render(<App />);
    await openSection('Сообщение');
    expect(jest.mocked(NavigationBar).mock.lastCall?.[0].style).toBe('dark');

    for (const [value, color, barStyle] of [['dark', '#edf2fa', 'light'], ['light', '#182333', 'dark'], [null, '#182333', 'dark']] as const) {
      await act(async () => {
        scheme = value;
        for (const listener of appearanceListeners) listener({ colorScheme: value });
      });
      expect(screen.getByRole('header', { name: 'Сообщение' })).toHaveStyle({ color });
      expect(screen.getByLabelText('Раздел «Сообщение»')).toBeSelected();
      expect(jest.mocked(NavigationBar).mock.lastCall?.[0].style).toBe(barStyle);
    }

    expect(await systemBack()).toBe(true);
    expect(screen.getByRole('header', { name: 'Сопряжение' })).toBeOnTheScreen();
  });

  it('восстанавливает сохранённое подключение, сохраняет тему и навигацию, удаляет токен локально', async () => {
    const token = 'C'.repeat(43);
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify({ format: 1, apiUrl: 'https://bot.example/api/v1', token }));
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ apiVersion: 1, version: '' }),
    } as Response);
    scheme = 'dark';
    await render(<App />);
    expect(await screen.findByText('Бот подключён. API совместим.')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Сопряжение' })).toHaveStyle({ color: '#edf2fa' });
    await openSection('Статус');
    await openSection('Сообщение');
    expect(await systemBack()).toBe(true);
    expect(screen.getByRole('header', { name: 'Статус' })).toBeOnTheScreen();
    await openSection('Сопряжение');
    await fireEvent.press(screen.getByRole('button', { name: 'Удалить токен с телефона' }));
    expect(await screen.findByRole('header', { name: 'Сопряжение' })).toBeOnTheScreen();
    expect(screen.queryByText('Бот подключён. API совместим.')).toBeNull();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('при недоступности повторяет подключение с сохранённым токеном', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify({ format: 1, apiUrl: 'https://bot.example/api/v1', token: 'D'.repeat(43) }));
    const request = jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Нет сети')).mockResolvedValue({
      ok: true, json: async () => ({ apiVersion: 1, version: '1.0' }),
    } as Response);
    await render(<App />);
    expect(await screen.findByRole('header', { name: 'Бот недоступен' })).toBeOnTheScreen();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Бот подключён. API совместим.')).toBeOnTheScreen();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
