import { format } from 'node:util';
import type { LogLevel, LogLine } from '../shared/api-v1.js';

/**
 * Последние строки консоли для вкладки «Лог» в панели. Перехватываем console,
 * а не заводим отдельный логгер: весь бот уже пишет через console.*.
 */

export type { LogLevel, LogLine };

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
