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
import { languageFromEnv, setSystemLocale, t } from '../src/i18n/index.js';
import { captureConsole } from '../src/log.js';
import { trayStatus, type IconState, type TrayStatus } from './trayStatus.js';
import { startUpdateChecks, type UpdateInfo } from './updates.js';

/**
 * Десктопная оболочка: бот и панель работают в фоне, в трее иконка со статусом,
 * окно — это та же веб-панель. Закрытие окна только прячет его.
 */

/** Имя приложения для ОС (процесс, Dock) — не переводится; в окнах и трее — t('app.name'). */
const APP_NAME = 'Анонсы стримов';
const REFRESH_MS = 5000;
const ASSETS = join(app.getAppPath(), 'desktop', 'assets');
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
/** Совпадает с appId в electron-builder.yml: Windows показывает уведомления только приложению с AppUserModelId. */
const APP_ID = 'ru.toytox.stream-announce';

app.setName(APP_NAME);
if (isWindows) app.setAppUserModelId(APP_ID);
// Для проверок и разработки: отдельная папка данных, чтобы не трогать настоящие .env и базу.
if (process.env.STREAM_BOT_USER_DATA) app.setPath('userData', process.env.STREAM_BOT_USER_DATA);

captureConsole();

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
let availableUpdate: UpdateInfo | undefined;

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
  // Автозапуск только для установленного приложения: в разработке система зарегистрировала бы голый Electron.
  // Включённый автозапуск перезаписываем всегда: после переезда exe (например, в Program Files) запись должна вести на текущий файл.
  // Выключенный снимаем только если он был включён.
  if (app.isPackaged && (settings.launchAtLogin || app.getLoginItemSettings().openAtLogin)) {
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

/** Язык интерфейса: APP_LANGUAGE из настроек панели, иначе язык системы. */
function lang(): string {
  return languageFromEnv(core?.env ?? {});
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
    dialog.showErrorBox(t(lang(), 'app.name'), t(lang(), 'tray.panelFailed'));
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

function currentStatus(): TrayStatus {
  const bot = core?.runtime.bot;
  const language = lang();
  if (!bot) {
    const configError = core?.runtime.configErrorSource?.localize(language) ?? core?.runtime.configError ?? null;
    return trayStatus(null, configError, language);
  }
  const broadcast = bot.announcer.status();
  return trayStatus(
    {
      dryRun: bot.config.dryRun,
      broadcast: broadcast && { startedAt: broadcast.startedAt, platforms: broadcast.platforms },
      failed: bot.announcer.platformStates().filter((item) => item.state === 'error').map((item) => item.platform),
    },
    null,
    language
  );
}

function trayIcon(state: IconState): Electron.NativeImage {
  // На macOS шаблон (*Template.png) система красит под светлую или тёмную строку меню.
  return nativeImage.createFromPath(join(ASSETS, isMac ? `${state}Template.png` : `${state}.png`));
}

function buildMenu(status: TrayStatus): Menu {
  const language = lang();
  const template: MenuItemConstructorOptions[] = [
    ...status.lines.map((label): MenuItemConstructorOptions => ({ label, enabled: false })),
    { type: 'separator' },
    { label: t(language, 'tray.openPanel'), click: () => showWindow() },
    {
      label: t(language, 'tray.checkNow'),
      enabled: Boolean(core?.runtime.bot),
      click: () => void core?.runtime.bot?.tickNow().then(refreshTray),
    },
    { type: 'separator' },
    app.isPackaged
      ? {
          label: t(language, 'tray.launchAtLogin'),
          type: 'checkbox',
          checked: settings.launchAtLogin,
          click: (item) => {
            settings.launchAtLogin = item.checked;
            saveSettings();
            applySettings();
          },
        }
      : { label: t(language, 'tray.launchAtLoginDev'), enabled: false },
    {
      label: t(language, 'tray.preventSleep'),
      type: 'checkbox',
      checked: settings.preventSleep,
      click: (item) => {
        settings.preventSleep = item.checked;
        saveSettings();
        applySettings();
      },
    },
    { type: 'separator' },
    ...(availableUpdate
      ? [
          {
            label: t(language, 'tray.updateAvailable', { version: availableUpdate.version }),
            click: () => void shell.openExternal(availableUpdate!.url),
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    { label: t(language, 'tray.version', { version: app.getVersion() }), enabled: false },
    { label: t(language, 'tray.quit'), click: () => app.quit() },
  ];
  return Menu.buildFromTemplate(template);
}

function refreshTray(): void {
  if (!tray) return;
  const status = currentStatus();
  // Меню пересобираем только при изменениях: открытое меню на macOS при замене закрывается.
  const key = `${lang()}|${status.state}|${status.lines.join('|')}|${Boolean(core?.runtime.bot)}|${availableUpdate?.version ?? ''}`;
  if (key === lastTrayKey) return;
  lastTrayKey = key;
  tray.setImage(trayIcon(status.state));
  tray.setToolTip(`${t(lang(), 'app.name')}\n${status.lines.join('\n')}`);
  tray.setContextMenu(buildMenu(status));
}

// ---------- Уведомления ----------

function notify(event: AnnouncerEvent): void {
  if (!Notification.isSupported()) return;
  const language = lang();
  const text = (() => {
    switch (event.type) {
      case 'announced':
        return { title: t(language, 'notify.announced'), body: event.platforms.join(', ') };
      case 'finished':
        return {
          title: t(language, 'notify.finished'),
          body: t(language, 'notify.finishedBody', { duration: formatDuration(event.durationMs, language) }),
        };
      case 'announce_failed':
        return { title: t(language, 'notify.announceFailed', { channel: event.channel }), body: event.error };
    }
  })();
  new Notification(text).show();
}

function onUpdate(info: UpdateInfo): void {
  const first = availableUpdate?.version !== info.version;
  availableUpdate = info;
  refreshTray();
  // Уведомляем один раз на версию, а не при каждой суточной проверке.
  if (first && Notification.isSupported()) {
    new Notification({
      title: t(lang(), 'notify.updateTitle'),
      body: t(lang(), 'notify.updateBody', { version: info.version }),
    }).show();
  }
}

// ---------- Запуск и выход ----------

async function main(): Promise<void> {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  const envPath = join(dataDir, '.env');
  const firstRun = !existsSync(envPath);

  // Язык системы нужен до запуска бота: по нему выбирается язык, если APP_LANGUAGE пуст.
  setSystemLocale(app.getLocale());
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
      version: app.getVersion(),
      onEvent: notify,
    });
  } catch (error) {
    dialog.showErrorBox(
      t(languageFromEnv({}), 'app.name'),
      t(languageFromEnv({}), 'tray.startFailed', { error: error instanceof Error ? error.message : String(error) })
    );
    app.exit(1);
    return;
  }

  if (isMac) app.dock?.setIcon(nativeImage.createFromPath(join(ASSETS, 'icon.png')));
  tray = new Tray(trayIcon('idle'));
  // На macOS клик открывает меню; на Windows меню по правому клику, а левый открывает окно.
  if (isWindows) tray.on('click', () => showWindow());
  refreshTray();
  setInterval(refreshTray, REFRESH_MS);
  startUpdateChecks(app.getVersion(), onUpdate);

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
