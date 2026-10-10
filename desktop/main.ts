import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  powerSaveBlocker,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnnouncerEvent } from '../src/announcer.js';
import { formatDuration } from '../src/announceTemplate.js';
import { startApp, type App } from '../src/app.js';
import { captureConsole } from '../src/log.js';
import { PLATFORM_LABELS } from '../src/types.js';

/**
 * Десктопная оболочка: бот и панель работают в фоне, в трее иконка со статусом,
 * окно — это та же веб-панель. Закрытие окна только прячет его.
 */

const APP_NAME = 'Анонсы стримов';
const REFRESH_MS = 5000;
const ASSETS = join(app.getAppPath(), 'desktop', 'assets');
const isMac = process.platform === 'darwin';

app.setName(APP_NAME);
// Для проверок и разработки: отдельная папка данных, чтобы не трогать настоящие .env и базу.
if (process.env.STREAM_BOT_USER_DATA) app.setPath('userData', process.env.STREAM_BOT_USER_DATA);

captureConsole();

type IconState = 'idle' | 'live' | 'warning' | 'stopped';

interface DesktopSettings {
  launchAtLogin: boolean;
  preventSleep: boolean;
}

let core: App | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let settings: DesktopSettings = { launchAtLogin: false, preventSleep: false };
let sleepBlockerId: number | undefined;
let lastTrayKey = '';
let quitting = false;

// ---------- Настройки приложения ----------

const settingsPath = () => join(app.getPath('userData'), 'desktop-settings.json');

function loadSettings(): void {
  try {
    settings = { ...settings, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) };
  } catch {
    // Первого запуска файла нет — остаются значения по умолчанию.
  }
}

function saveSettings(): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('❌ Не удалось сохранить настройки приложения:', error instanceof Error ? error.message : error);
  }
}

function applySettings(): void {
  // Трогаем системную настройку только при изменении: в dev-запуске регистрация может быть запрещена.
  if (app.getLoginItemSettings().openAtLogin !== settings.launchAtLogin) {
    // openAsHidden есть не во всех версиях типов Electron, но старым macOS он нужен.
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, openAsHidden: true } as Electron.Settings);
  }
  const blocking = sleepBlockerId !== undefined && powerSaveBlocker.isStarted(sleepBlockerId);
  if (settings.preventSleep && !blocking) {
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!settings.preventSleep && blocking) {
    powerSaveBlocker.stop(sleepBlockerId!);
    sleepBlockerId = undefined;
  }
}

// ---------- Окно ----------

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    title: APP_NAME,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const origin = new URL(url).origin;

  // Окно показывает только панель: чужие адреса не открываем ни здесь, ни в новых окнах.
  const guard = (event: Electron.Event, target: string) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  };
  win.webContents.on('will-navigate', (event) => guard(event, event.url));
  win.webContents.on('will-redirect', (event) => guard(event, event.url));
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (isMac) app.dock?.hide();
  });
  win.once('ready-to-show', () => win.show());
  void win.loadURL(url);
  return win;
}

function showWindow(hash = ''): void {
  if (!core?.panelUrl) {
    dialog.showErrorBox(APP_NAME, 'Панель не запустилась — подробности в логе. Перезапустите приложение.');
    return;
  }
  if (isMac) void app.dock?.show();
  if (!window || window.isDestroyed()) {
    window = createWindow(core.panelUrl + hash);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// ---------- Трей ----------

interface TrayStatus {
  state: IconState;
  lines: string[];
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function currentStatus(): TrayStatus {
  const bot = core?.runtime.bot;
  if (!bot) {
    const reason = core?.runtime.configError ?? 'неизвестная ошибка';
    return { state: 'stopped', lines: [`Бот не запущен: ${reason.length > 90 ? `${reason.slice(0, 90)}…` : reason}`] };
  }

  const broadcast = bot.announcer.status();
  const failed = bot.announcer.platformStates().filter((item) => item.state === 'error');
  const live = broadcast
    ? `● Эфир идёт с ${clock(broadcast.startedAt)} · ${broadcast.platforms.map((p) => PLATFORM_LABELS[p]).join(', ')}`
    : 'Эфира нет';

  const lines = [bot.config.dryRun ? (broadcast ? `Тестовый режим · ${live}` : 'Тестовый режим') : live];
  if (failed.length > 0) lines.push(`Ошибка проверки: ${failed.map((item) => PLATFORM_LABELS[item.platform]).join(', ')}`);

  let state: IconState = broadcast ? 'live' : 'idle';
  if (bot.config.dryRun || failed.length > 0) state = 'warning';
  return { state, lines };
}

function trayIcon(state: IconState): Electron.NativeImage {
  // На macOS шаблон (*Template.png) система красит под светлую или тёмную строку меню.
  return nativeImage.createFromPath(join(ASSETS, isMac ? `${state}Template.png` : `${state}.png`));
}

function buildMenu(status: TrayStatus): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...status.lines.map((label): MenuItemConstructorOptions => ({ label, enabled: false })),
    { type: 'separator' },
    { label: 'Открыть панель', click: () => showWindow() },
    {
      label: 'Проверить сейчас',
      enabled: Boolean(core?.runtime.bot),
      click: () => void core?.runtime.bot?.tickNow().then(refreshTray),
    },
    { type: 'separator' },
    {
      label: 'Запускать при входе в систему',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: (item) => {
        settings.launchAtLogin = item.checked;
        saveSettings();
        applySettings();
      },
    },
    {
      label: 'Не давать системе засыпать',
      type: 'checkbox',
      checked: settings.preventSleep,
      click: (item) => {
        settings.preventSleep = item.checked;
        saveSettings();
        applySettings();
      },
    },
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() },
  ];
  return Menu.buildFromTemplate(template);
}

function refreshTray(): void {
  if (!tray) return;
  const status = currentStatus();
  // Меню пересобираем только при изменениях: открытое меню на macOS при замене закрывается.
  const key = `${status.state}|${status.lines.join('|')}|${Boolean(core?.runtime.bot)}`;
  if (key === lastTrayKey) return;
  lastTrayKey = key;
  tray.setImage(trayIcon(status.state));
  tray.setToolTip(`${APP_NAME}\n${status.lines.join('\n')}`);
  tray.setContextMenu(buildMenu(status));
}

// ---------- Уведомления ----------

function notify(event: AnnouncerEvent): void {
  if (!Notification.isSupported()) return;
  const text = (() => {
    switch (event.type) {
      case 'announced':
        return { title: 'Анонс отправлен', body: event.platforms.join(', ') };
      case 'finished':
        return { title: 'Эфир завершён', body: `Длился ${formatDuration(event.durationMs)}` };
      case 'announce_failed':
        return { title: 'Не удалось отправить анонс', body: event.error };
    }
  })();
  new Notification(text).show();
}

// ---------- Запуск и выход ----------

async function main(): Promise<void> {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  const envPath = join(dataDir, '.env');
  const firstRun = !existsSync(envPath);

  loadSettings();
  applySettings();

  try {
    core = await startApp({
      envPath,
      fallbackPort: true,
      forcePanel: true,
      // В GUI-приложении окружение процесса — не настройки бота.
      inheritProcessEnv: false,
      defaults: { DATABASE_PATH: join(dataDir, 'bot.db') },
      onEvent: notify,
    });
  } catch (error) {
    dialog.showErrorBox(APP_NAME, `Не удалось запустить: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
    return;
  }

  if (isMac) app.dock?.setIcon(nativeImage.createFromPath(join(ASSETS, 'icon.png')));
  tray = new Tray(trayIcon('idle'));
  if (!isMac) tray.on('click', () => showWindow());
  refreshTray();
  setInterval(refreshTray, REFRESH_MS);

  // Без настроек или с ошибкой в них сразу ведём на вкладку «Настройки»; иначе живём тихо в трее.
  if (firstRun || !core.runtime.bot) showWindow('#settings');
  else if (isMac) app.dock?.hide();
}

if (!app.requestSingleInstanceLock()) {
  // Уже запущена другая копия (с этой же папкой данных) — она получит second-instance.
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  // Окна закрываются «в трей»: приложение живёт, пока не выбрано «Выйти».
  app.on('window-all-closed', () => {});
  app.on('activate', () => showWindow());
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (core?.stop() ?? Promise.resolve())
      .catch((error: unknown) => console.error('❌ Ошибка при остановке:', error))
      .finally(() => app.exit(0));
  });
  void app.whenReady().then(main);
}
