/** Подпись к фото в Telegram ограничена 1024 символами — за этим следит trimToLimit(). */
export const CAPTION_LIMIT = 1024;

export const GREETING = 'Всем привет';

export const THANKS = 'Всем спасибо, кто забегал на стрим, повтор стрима можно посмотреть тут:';

export interface AnnounceInput {
  title: string;
  game?: string | null;
  customText?: string | null;
  links: ChannelLink[];
}

/** Ссылка в сообщении: подпись своя, потому что VK Video и VK Live — разные ссылки одной площадки. */
export interface ChannelLink {
  label: string;
  url: string;
}

export interface FinishedInput {
  title: string;
  game?: string | null;
  durationMs: number;
  links: ChannelLink[];
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

/** Ссылки столбцом: по строке на площадку. */
function linksBlock(links: ChannelLink[]): string {
  return links
    .map((link) => `▶️ <a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`)
    .join('\n');
}

function titleBlock(icon: string, title: string, game?: string | null): string {
  const lines = [`${icon} <b>${escapeHtml(title)}</b>`];
  if (game) lines.push(`🎮 ${escapeHtml(game)}`);
  return lines.join('\n');
}

export function renderAnnounce(input: AnnounceInput): string {
  const head = `${GREETING}\n\n${titleBlock('🔴', input.title, input.game)}`;
  const tailText = linksBlock(input.links);

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

/** Итог эфира — отдельное сообщение: ссылки ведут на каналы, где лежит запись. */
export function renderFinished(input: FinishedInput): string {
  return [
    titleBlock('⚫️', input.title, input.game),
    `Эфир завершён, длился ${formatDuration(input.durationMs)}`,
    THANKS,
    linksBlock(input.links),
  ].join('\n\n');
}
