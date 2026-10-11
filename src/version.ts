import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Версия из package.json; ищем вверх по дереву, как web/index.html: код лежит в dist/ или dist-desktop/src/. */
export function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        return String(JSON.parse(readFileSync(candidate, 'utf8')).version ?? '');
      } catch {
        return '';
      }
    }
    dir = dirname(dir);
  }
  return '';
}
