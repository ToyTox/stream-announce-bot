import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

export function readJsonFixture<T>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}
