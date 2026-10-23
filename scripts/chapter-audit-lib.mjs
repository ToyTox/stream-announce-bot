// Чистая логика аудита глав: разбор плана и расчёт окна запуска. Без файлов, git и запуска claude,
// чтобы это можно было проверить тестами (tests/unit/chapterAudit.test.ts).

const WEEK_MINUTES = 7 * 24 * 60;
const DAY_NAMES = [
  ['sun', 'вс'],
  ['mon', 'пн'],
  ['tue', 'вт'],
  ['wed', 'ср'],
  ['thu', 'чт'],
  ['fri', 'пт'],
  ['sat', 'сб'],
];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** День недели: 0–6 (0 — воскресенье), английское или русское сокращение. Возвращает число или null. */
export function parseWeekday(value) {
  const text = String(value).trim().toLowerCase();
  if (/^[0-6]$/.test(text)) return Number(text);
  const index = DAY_NAMES.findIndex((names) => names.some((name) => text.startsWith(name)));
  return index === -1 ? null : index;
}

/** Время «ЧЧ:ММ» → минуты от полуночи или null. */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Разбирает раздел «Задачи» плана: главы `**A. ...**` и пункты `- [x] 10a. ...`.
 * Пункты без номера (например, «Аудит главы») в задачи не входят.
 */
export function parseChapters(markdown) {
  const start = markdown.search(/^## Задачи\s*$/m);
  if (start === -1) return [];
  const rest = markdown.slice(start).split('\n').slice(1);
  const chapters = [];
  let current = null;
  for (const line of rest) {
    if (/^## /.test(line)) break;
    const heading = /^\*\*([A-Z])\.\s/.exec(line);
    if (heading) {
      current = { id: heading[1], tasks: [] };
      chapters.push(current);
      continue;
    }
    if (line.startsWith('**')) {
      current = null;
      continue;
    }
    const task = /^- \[( |x|X)\] (\d+[a-z]?)\./.exec(line);
    if (task && current) current.tasks.push({ id: task[2], done: task[1] !== ' ' });
  }
  return chapters.map((chapter) => ({
    ...chapter,
    closed: chapter.tasks.length > 0 && chapter.tasks.every((task) => task.done),
  }));
}

/** Первая закрытая глава A, B или C, по которой ещё нет отчёта. */
export function findChapterToAudit(chapters, hasReport) {
  const found = chapters.find((chapter) => 'ABC'.includes(chapter.id) && chapter.closed && !hasReport(chapter.id));
  return found ? found.id : null;
}

function mod(value, base) {
  return ((value % base) + base) % base;
}

function weekPosition(now, timeZone) {
  if (!timeZone) {
    return now.getDay() * 1440 + now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '0';
  return (
    (WEEKDAY_INDEX[get('weekday')] ?? 0) * 1440 + Number(get('hour')) * 60 + Number(get('minute')) + Number(get('second')) / 60
  );
}

/**
 * Где сейчас время относительно ближайшего сброса недельного лимита.
 * config: { resetDay: 0–6, resetMinutes: минуты от полуночи, leadMinutes, timeZone? } (без timeZone — часовой пояс системы).
 * state: 'before' — окно ещё не началось, 'inside' — идёт окно (lead минут до сброса),
 * 'missed' — сброс только что прошёл (не позже lead минут назад), окно пропущено.
 * windowId — момент сброса, к которому относится окно, с точностью до минуты.
 * Переход летнего времени внутри недели сдвигает расчёт не больше чем на час.
 */
export function windowStatus(now, config) {
  const reset = config.resetDay * 1440 + config.resetMinutes;
  const position = weekPosition(now, config.timeZone);
  const until = mod(reset - position, WEEK_MINUTES);
  const since = mod(position - reset, WEEK_MINUTES);
  const toId = (offsetMinutes) => new Date(Math.round((now.getTime() + offsetMinutes * 60000) / 60000) * 60000).toISOString();
  if (until > 0 && until <= config.leadMinutes) {
    return { state: 'inside', windowId: toId(until), minutesToReset: until };
  }
  if (since <= config.leadMinutes) {
    return { state: 'missed', windowId: toId(-since), minutesToReset: until };
  }
  return { state: 'before', windowId: toId(until), minutesToReset: until };
}

/** Момент ближайшего сброса не раньше sample в поясе timeZone (с поправкой на переход летнего времени между ними). */
function resetInstantAfter(sample, config) {
  const reset = config.resetDay * 1440 + config.resetMinutes;
  const until = mod(reset - weekPosition(sample, config.timeZone), WEEK_MINUTES);
  let instant = sample.getTime() + until * 60000;
  for (let i = 0; i < 2; i++) {
    const delta = mod(reset - weekPosition(new Date(instant), config.timeZone) + WEEK_MINUTES / 2, WEEK_MINUTES) - WEEK_MINUTES / 2;
    instant += delta * 60000;
  }
  return instant;
}

/**
 * Срабатывания launchd внутри окна: каждые stepMinutes за lead минут до сброса, формат StartCalendarInterval.
 * launchd трактует расписание в поясе Mac (localTimeZone, по умолчанию системный). Если задан config.timeZone,
 * окно переводится в пояс Mac по реальному времени на каждый день ближайшего года; разные даты перехода на
 * летнее время дают разные сдвиги, и расписание объединяет их, поэтому оно не устаревает целый год.
 */
export function calendarIntervals(config, { stepMinutes = 15, from = new Date(), localTimeZone } = {}) {
  const offsets = [];
  for (let offset = stepMinutes; offset < config.leadMinutes + stepMinutes; offset += stepMinutes) {
    offsets.push(Math.min(offset, config.leadMinutes));
  }
  const result = [];
  const add = (at) => {
    const entry = { Weekday: Math.floor(at / 1440), Hour: Math.floor((at % 1440) / 60), Minute: at % 60 };
    if (!result.some((item) => item.Weekday === entry.Weekday && item.Hour === entry.Hour && item.Minute === entry.Minute)) {
      result.push(entry);
    }
  };
  if (!config.timeZone) {
    const reset = config.resetDay * 1440 + config.resetMinutes;
    for (const offset of offsets) add(mod(reset - offset, WEEK_MINUTES));
    return result;
  }
  for (let day = 0; day <= 370; day++) {
    const instant = resetInstantAfter(new Date(from.getTime() + day * 86400000), config);
    for (const offset of offsets) {
      add(Math.floor(weekPosition(new Date(instant - offset * 60000), localTimeZone)));
    }
  }
  return result.sort((x, y) => x.Weekday - y.Weekday || x.Hour - y.Hour || x.Minute - y.Minute);
}

/**
 * Решение о запуске. input: { now, config, planText, hasReport(id), state: { lastWindow?, lastMissed? } }.
 * action: 'run' | 'skip'; reason — понятная причина; missedWindow — окно, о пропуске которого нужно записать в лог.
 */
export function decide({ now, config, planText, hasReport, state }) {
  const window = windowStatus(now, config);
  if (window.state === 'before') {
    return { action: 'skip', window, reason: `окно ещё не началось, до сброса ${Math.round(window.minutesToReset)} мин` };
  }
  if (window.state === 'missed') {
    return { action: 'skip', window, reason: 'окно пропущено, перенос на следующую неделю', missedWindow: window.windowId };
  }
  if (state.lastWindow === window.windowId) {
    return { action: 'skip', window, reason: 'в этом окне аудит уже запускался, следующая попытка в окне следующей недели' };
  }
  const chapter = findChapterToAudit(parseChapters(planText), hasReport);
  if (!chapter) return { action: 'skip', window, reason: 'нет закрытой главы без отчёта (глава не закрыта или отчёт уже есть)' };
  return { action: 'run', window, chapter, reason: `идёт окно, глава ${chapter} закрыта и без отчёта` };
}

/** Какие задачи и каталоги проверять для главы. */
const CHAPTER_FOCUS = {
  A: 'сервер: `src/`, `/api/v1`, устройства и токены, проверка Host/Origin, ограничение частоты, `REMOTE_ENABLED` и адрес Tailscale',
  B: 'приложение `mobile/`: хранение токена, клиент API, обработка недоступного бота, сопряжение, зависимости',
  C: 'уведомления и выпуск: push-токены и отправка через FCM, секреты в CI, подпись `.apk` и её хранение в `.github/workflows/`',
};

/** Правило разрешений на запись: только каталог отчётов в рабочей копии (`//` — абсолютный путь от корня ФС). */
export function reportAllowRule(worktree) {
  return `Edit(/${worktree.replace(/\/+$/, '')}/docs/audits/**)`;
}

/**
 * Аргументы `claude -p`: без отключения запросов разрешений и режимов обхода. Всё, что не разрешено явно, отклоняется (dontAsk).
 * Промпт передаётся через stdin, а не аргументом.
 */
export function buildClaudeArgs({ worktree, maxTurns = 60 }) {
  return [
    '-p',
    '--agent', 'chapter-auditor',
    '--model', 'fable',
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Grep,Glob,Write',
    '--allowedTools', reportAllowRule(worktree),
    '--disallowedTools', 'Agent',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--max-turns', String(maxTurns),
    '--no-session-persistence',
  ];
}

/** Промпт агента: глава, файл отчёта и файл с git-контекстом (git агент не вызывает). */
export function buildPrompt({ chapter, contextFile }) {
  return [
    `Проведи аудит главы ${chapter} по плану docs/mobile-app-plan.md.`,
    `Фокус: ${CHAPTER_FOCUS[chapter] ?? 'вся глава'}.`,
    `Состояние main, историю и изменения главы прочитай в файле ${contextFile}: git тебе недоступен.`,
    `Запиши отчёт в docs/audits/chapter-${chapter}.md и больше нигде ничего не создавай.`,
  ].join('\n');
}

/** Путь агента в репозитории: рабочая копия делается из `main`, поэтому агент должен быть закоммичен туда. */
export const AGENT_PATH = '.claude/agents/chapter-auditor.md';

export const AGENT_MISSING_MESSAGE = `ошибка: на main нет ${AGENT_PATH}. Сначала закоммитьте в main агента и скрипты аудита (scripts/chapter-audit*.mjs), claude не вызывался.`;

/** Свежесть блокировки без pid-файла: запуск мог только что создать каталог и ещё не записать pid. */
export const LOCK_FRESH_MS = 5 * 60 * 1000;

/**
 * Занята ли блокировка. input: { pid: число | null (файл не прочитан), pidAlive(pid), ageMs — возраст каталога блокировки }.
 * 'busy' — держит другой запуск, 'stale' — блокировку можно снять.
 */
export function lockVerdict({ pid, pidAlive, ageMs }) {
  if (pid == null || !(pid > 0)) return ageMs < LOCK_FRESH_MS ? 'busy' : 'stale';
  return pidAlive(pid) ? 'busy' : 'stale';
}

/** Последняя строка полного отчёта: агент пишет её, когда закончил все разделы. Без неё отчёт считается неполным. */
export const REPORT_COMPLETE_MARKER = '<!-- chapter-audit: complete -->';

/** Полный ли отчёт: непустой, и его последняя непустая строка — метка завершения. */
export function isReportComplete(text) {
  if (typeof text !== 'string') return false;
  const lines = text.trim().split('\n');
  return lines[lines.length - 1].trim() === REPORT_COMPLETE_MARKER;
}

/**
 * Успешен ли запуск claude. input: { code, timedOut, reportText: string | null (отчёта нет) }.
 * Только успех переносит отчёт в docs/audits/, иначе глава остаётся неаудированной.
 */
export function auditOutcome({ code, timedOut, reportText }) {
  if (timedOut) return { ok: false, reason: 'claude прерван по времени до сброса лимита' };
  if (code !== 0) return { ok: false, reason: `claude завершился с кодом ${code} (ошибка или исчерпаны ходы)` };
  if (reportText == null) return { ok: false, reason: 'отчёта нет' };
  if (!isReportComplete(reportText)) return { ok: false, reason: 'отчёт неполный: нет метки завершения' };
  return { ok: true, reason: 'отчёт полный' };
}

/** Запас до сброса, на который claude завершается раньше, и минимум времени, при котором запуск ещё имеет смысл. */
export const RESET_MARGIN_MINUTES = 5;
export const MIN_RUN_MINUTES = 20;
export const MAX_RUN_MINUTES = 4 * 60;

/**
 * Сколько можно работать claude до ближайшего сброса недельного лимита. Не зависит от окна (плановый и ручной запуск).
 * Возвращает { allowed, timeoutMs, minutesToReset, reason }.
 */
export function claudeDeadline(now, config) {
  const minutesToReset = windowStatus(now, config).minutesToReset;
  const available = minutesToReset - RESET_MARGIN_MINUTES;
  if (available < MIN_RUN_MINUTES) {
    return {
      allowed: false,
      timeoutMs: 0,
      minutesToReset,
      reason: `до сброса лимита ${Math.round(minutesToReset)} мин, нужно не меньше ${MIN_RUN_MINUTES + RESET_MARGIN_MINUTES}: claude не запускается`,
    };
  }
  const minutes = Math.min(available, MAX_RUN_MINUTES);
  return {
    allowed: true,
    timeoutMs: Math.floor(minutes * 60000),
    minutesToReset,
    reason: `до сброса лимита ${Math.round(minutesToReset)} мин, claude прервётся через ${Math.floor(minutes)} мин`,
  };
}

/**
 * Решение run-now (окно не проверяется). input: { chapter, planText, hasReport(id), force }.
 * force снимает только проверку «глава закрыта».
 */
export function decideManual({ chapter, planText, hasReport, force }) {
  if (hasReport(chapter)) return { action: 'refuse', reason: `отчёт по главе ${chapter} уже есть (docs/audits/chapter-${chapter}.md в рабочем каталоге или на main)` };
  const found = parseChapters(planText).find((item) => item.id === chapter);
  if (!found?.closed) {
    if (!force) return { action: 'refuse', reason: `глава ${chapter} на main не закрыта; для аудита незакрытой главы добавьте --force-open` };
    return { action: 'run', reason: `глава ${chapter} не закрыта, запуск принудительный (--force-open)` };
  }
  return { action: 'run', reason: `глава ${chapter} закрыта и без отчёта` };
}
