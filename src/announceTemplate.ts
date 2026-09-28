import { PLATFORM_LABELS, Platform } from './types.js';

/** Подпись к фото в Telegram ограничена 1024 символами — за этим следит trimToLimit(). */
export const CAPTION_LIMIT = 1024;

export interface AnnounceLink {
  platform: Platform;
  url: string;
}

export interface AnnounceInput {
  title: string;
  game?: string | null;
  customText?: string | null;
  links: AnnounceLink[];
  /** Заполняется после окончания эфира: длительность в миллисекундах. */
  endedAfterMs?: number;
}

/** Экранирование для parse_mode=HTML: в названиях стримов амперсанд встречается регулярно. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} мин`;
  if (minutes === 0) return `${hours} ч`;
  return `${hours} ч ${minutes} мин`;
}

/**
 * Режет по границе так, чтобы не порвать HTML-тег: обрезаем только врезку
 * (единственную часть произвольной длины), остальное всегда короткое.
 */
function trimCustomText(text: string, budget: number): string {
  if (budget <= 1) return '';
  if (text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
}

function linksLine(links: AnnounceLink[]): string {
  return links
    .map((link) => `<a href="${escapeHtml(link.url)}">${PLATFORM_LABELS[link.platform]}</a>`)
    .join(' · ');
}

export function renderAnnounce(input: AnnounceInput): string {
  const header =
    input.endedAfterMs === undefined
      ? `🔴 <b>${escapeHtml(input.title)}</b>`
      : `⚫️ <b>${escapeHtml(input.title)}</b>`;

  const parts: string[] = [header];
  if (input.game) parts.push(`🎮 ${escapeHtml(input.game)}`);

  const head = parts.join('\n');

  const tail: string[] = [];
  if (input.endedAfterMs !== undefined) {
    tail.push(`Эфир завершён, длился ${formatDuration(input.endedAfterMs)}`);
  } else if (input.links.length > 0) {
    tail.push(`▶️ ${linksLine(input.links)}`);
  }
  const tailText = tail.join('\n');

  const custom = input.customText?.trim();
  if (!custom) {
    return tailText ? `${head}\n\n${tailText}` : head;
  }

  // Бюджет врезки — то, что осталось от лимита после обязательных частей и двух пустых строк.
  const budget = CAPTION_LIMIT - head.length - tailText.length - 4;
  const trimmed = trimCustomText(escapeHtml(custom), budget);
  if (!trimmed) {
    return tailText ? `${head}\n\n${tailText}` : head;
  }

  return tailText ? `${head}\n\n${trimmed}\n\n${tailText}` : `${head}\n\n${trimmed}`;
}
