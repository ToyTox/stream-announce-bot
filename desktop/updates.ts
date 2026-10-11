/**
 * Проверка новой версии: смотрим последний релиз на GitHub и сравниваем с текущей.
 * Сама функция сравнения чистая, чтобы её можно было проверить тестом без Electron.
 */

const RELEASE_API = 'https://api.github.com/repos/ToyTox/stream-announce-bot/releases/latest';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  url: string;
}

/** Разбирает «v1.2.3» / «1.2.3-beta.1» в числа; null, если это не версия. Суффикс после «-» отбрасывается. */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** true, если candidate новее current. Непонятная версия новее не считается. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

async function fetchLatest(): Promise<UpdateInfo | null> {
  const response = await fetch(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'stream-announce-bot' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof data.tag_name !== 'string' || typeof data.html_url !== 'string' || data.draft || data.prerelease) return null;
  return { version: data.tag_name.replace(/^v/, ''), url: data.html_url };
}

/**
 * Проверяет при старте и раз в сутки. onUpdate вызывается при каждой проверке, где нашлась
 * новая версия; ошибки сети молча игнорируются — следующая попытка через сутки.
 */
export function startUpdateChecks(currentVersion: string, onUpdate: (info: UpdateInfo) => void): () => void {
  const check = async () => {
    try {
      const latest = await fetchLatest();
      if (latest && isNewerVersion(latest.version, currentVersion)) onUpdate(latest);
    } catch {
      // Нет сети или GitHub недоступен — не страшно.
    }
  };
  void check();
  const timer = setInterval(() => void check(), DAY_MS);
  return () => clearInterval(timer);
}
