import { t, type Lang } from '../src/i18n/index.js';
import { PLATFORM_LABELS, type Platform } from '../src/types.js';

/**
 * Статус для трея без зависимости от Electron: так строки на каждом языке проверяются тестом.
 */

export type IconState = 'idle' | 'live' | 'warning' | 'stopped';

export interface TrayStatus {
  state: IconState;
  lines: string[];
}

/** Что нужно знать о боте, чтобы описать его в трее; null — бот не запущен. */
export interface TrayBotInfo {
  dryRun: boolean;
  broadcast: { startedAt: number; platforms: Platform[] } | null;
  /** Площадки, последняя проверка которых завершилась ошибкой. */
  failed: Platform[];
}

function clock(ms: number, lang: Lang): string {
  return new Date(ms).toLocaleTimeString(t(lang, 'locale'), { hour: '2-digit', minute: '2-digit' });
}

export function trayStatus(bot: TrayBotInfo | null, configError: string | null, lang: Lang): TrayStatus {
  if (!bot) {
    const reason = configError ?? t(lang, 'tray.unknownError');
    return { state: 'stopped', lines: [t(lang, 'tray.notRunning', { reason: reason.length > 90 ? `${reason.slice(0, 90)}…` : reason })] };
  }

  const { broadcast, failed } = bot;
  const live = broadcast
    ? t(lang, 'tray.live', {
        time: clock(broadcast.startedAt, lang),
        platforms: broadcast.platforms.map((p) => PLATFORM_LABELS[p]).join(', '),
      })
    : t(lang, 'tray.noBroadcast');

  const lines = [bot.dryRun ? (broadcast ? t(lang, 'tray.dryRunLive', { live }) : t(lang, 'tray.dryRun')) : live];
  if (failed.length > 0) lines.push(t(lang, 'tray.checkFailed', { platforms: failed.map((p) => PLATFORM_LABELS[p]).join(', ') }));

  let state: IconState = broadcast ? 'live' : 'idle';
  if (bot.dryRun || failed.length > 0) state = 'warning';
  return { state, lines };
}
