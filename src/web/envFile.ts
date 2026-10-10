import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Запись настроек обратно в .env. Файл правим построчно: меняем значения
 * существующих ключей и дописываем новые в конец, комментарии и порядок
 * остаются как были — .env по-прежнему можно читать и править руками.
 */

const LINE_KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Кавычки нужны, только если без них dotenv прочитает значение иначе. */
export function formatEnvValue(value: string): string {
  if (!/[\s#"'`\\]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function updateEnvContent(content: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');

  const updated = lines.map((line) => {
    const key = LINE_KEY.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${formatEnvValue(value)}`;
  });

  for (const [key, value] of pending) updated.push(`${key}=${formatEnvValue(value)}`);
  return `${updated.join('\n')}\n`;
}

/** Через временный файл: оборванная запись не оставит полупустой .env. */
export function writeEnvFile(path: string, values: Record<string, string>): void {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, updateEnvContent(current, values), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Импорт: файл заменяется целиком, старые комментарии и ключи не сохраняются. */
export function replaceEnvFile(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
