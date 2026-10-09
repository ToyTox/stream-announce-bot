import { format } from 'node:util';

/**
 * Последние строки консоли для вкладки «Лог» в панели. Перехватываем console,
 * а не заводим отдельный логгер: весь бот уже пишет через console.*.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  /** Сквозной номер: панель запрашивает только то, что новее последнего увиденного. */
  seq: number;
  time: number;
  level: LogLevel;
  text: string;
}

const MAX_LINES = 300;

const lines: LogLine[] = [];
let seq = 0;
let installed = false;

export function pushLog(level: LogLevel, text: string): void {
  lines.push({ seq: ++seq, time: Date.now(), level, text });
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export function captureConsole(): void {
  if (installed) return;
  installed = true;

  const wrap = (method: 'log' | 'warn' | 'error', level: LogLevel) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      pushLog(level, format(...args));
      original(...args);
    };
  };
  wrap('log', 'info');
  wrap('warn', 'warn');
  wrap('error', 'error');
}

export function recentLogs(after = 0): LogLine[] {
  return lines.filter((line) => line.seq > after);
}
