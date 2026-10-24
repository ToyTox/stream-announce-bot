import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSING_MESSAGE,
  auditOutcome,
  buildClaudeArgs,
  buildPrompt,
  calendarIntervals,
  claudeDeadline,
  decide,
  decideManual,
  findChapterToAudit,
  isReportComplete,
  LOCK_FRESH_MS,
  lockVerdict,
  parseChapters,
  parseClock,
  parseWeekday,
  REPORT_COMPLETE_MARKER,
  windowStatus,
} from '../../scripts/chapter-audit-lib.mjs';

const plan = (a: string, b = '- [ ] 11. Каркас.') =>
  ['## Задачи', '', '**A. Сервер**', '', a, '- Аудит главы A: автоматически.', '', '**B. Приложение**', '', b, '', '**Зависимости:** 11 после 2.', ''].join('\n');

describe('parseChapters', () => {
  it('глава закрыта, когда отмечены все задачи, включая с буквенным номером', () => {
    const chapters = parseChapters(plan('- [x] 10. Контракт.\n- [x] 10a. Общие типы.'));
    expect(chapters.map((c) => [c.id, c.closed])).toEqual([['A', true], ['B', false]]);
    expect(chapters[0]?.tasks.map((t) => t.id)).toEqual(['10', '10a']);
  });

  it('частично отмеченная глава и неотмеченная 10a не считаются закрытыми', () => {
    expect(parseChapters(plan('- [x] 10. Контракт.\n- [ ] 10a. Общие типы.'))[0]?.closed).toBe(false);
  });

  it('пункт «Аудит главы» без номера не мешает закрытию и без раздела задач глав нет', () => {
    expect(parseChapters(plan('- [x] 1. Всё.'))[0]?.closed).toBe(true);
    expect(parseChapters('# План\n')).toEqual([]);
  });
});

describe('findChapterToAudit', () => {
  const chapters = parseChapters(plan('- [x] 1. Всё.', '- [x] 11. Каркас.'));

  it('берёт первую закрытую главу без отчёта', () => {
    expect(findChapterToAudit(chapters, () => false)).toBe('A');
    expect(findChapterToAudit(chapters, (id) => id === 'A')).toBe('B');
  });

  it('если отчёты есть, аудит не нужен', () => {
    expect(findChapterToAudit(chapters, () => true)).toBeNull();
  });
});

describe('windowStatus', () => {
  // Сброс во вторник в 18:30 по Москве (15:30 UTC), запас 120 минут.
  const config = { resetDay: 2, resetMinutes: 18 * 60 + 30, leadMinutes: 120, timeZone: 'Europe/Moscow' };

  it('до окна, внутри окна и после сброса', () => {
    expect(windowStatus(new Date('2026-10-27T12:00:00Z'), config).state).toBe('before');
    const inside = windowStatus(new Date('2026-10-27T14:00:00Z'), config);
    expect(inside.state).toBe('inside');
    expect(inside.minutesToReset).toBe(90);
    expect(inside.windowId).toBe('2026-10-27T15:30:00.000Z');
    const missed = windowStatus(new Date('2026-10-27T16:00:00Z'), config);
    expect(missed.state).toBe('missed');
    expect(missed.windowId).toBe('2026-10-27T15:30:00.000Z');
    expect(windowStatus(new Date('2026-10-27T18:00:00Z'), config).state).toBe('before');
  });

  it('границы окна: ровно за запас до сброса внутри, в момент сброса уже нет', () => {
    expect(windowStatus(new Date('2026-10-27T13:30:00Z'), config).state).toBe('inside');
    expect(windowStatus(new Date('2026-10-27T13:29:00Z'), config).state).toBe('before');
    expect(windowStatus(new Date('2026-10-27T15:30:00Z'), config).state).toBe('missed');
  });

  it('окно через полночь и границу недели', () => {
    // Сброс в воскресенье в 00:30, запас 120 минут: окно начинается в субботу в 22:30.
    const sunday = { resetDay: 0, resetMinutes: 30, leadMinutes: 120, timeZone: 'UTC' };
    const inside = windowStatus(new Date('2026-10-24T23:00:00Z'), sunday);
    expect(inside.state).toBe('inside');
    expect(inside.windowId).toBe('2026-10-25T00:30:00.000Z');
    expect(windowStatus(new Date('2026-10-24T22:00:00Z'), sunday).state).toBe('before');
    expect(windowStatus(new Date('2026-10-25T01:00:00Z'), sunday).state).toBe('missed');
  });

  it('часовой пояс влияет на расчёт', () => {
    const utc = { ...config, timeZone: 'UTC' };
    expect(windowStatus(new Date('2026-10-27T14:00:00Z'), utc).state).toBe('before');
    expect(windowStatus(new Date('2026-10-27T14:00:00Z'), { ...config, timeZone: 'America/New_York' }).state).toBe('before');
  });
});

describe('calendarIntervals', () => {
  it('срабатывания каждые 15 минут внутри окна, с переходом через полночь и неделю', () => {
    const intervals = calendarIntervals({ resetDay: 0, resetMinutes: 30, leadMinutes: 60 });
    expect(intervals).toEqual([
      { Weekday: 0, Hour: 0, Minute: 15 },
      { Weekday: 0, Hour: 0, Minute: 0 },
      { Weekday: 6, Hour: 23, Minute: 45 },
      { Weekday: 6, Hour: 23, Minute: 30 },
    ]);
  });
});

describe('calendarIntervals с --tz', () => {
  const minutesOf = (entry: { Weekday: number; Hour: number; Minute: number }) => entry.Weekday * 1440 + entry.Hour * 60 + entry.Minute;
  const localPosition = (date: Date, timeZone: string) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return day * 1440 + Number(get('hour')) * 60 + Number(get('minute'));
  };
  // Для каждого окна каждой недели года: срабатывания в поясе Mac дают минимум по срабатыванию на каждые 15 минут окна.
  const check = (config: { resetDay: number; resetMinutes: number; leadMinutes: number; timeZone: string }, mac: string) => {
    const from = new Date('2026-01-01T00:00:00Z');
    const set = new Set(calendarIntervals(config, { from, localTimeZone: mac }).map(minutesOf));
    for (let day = 0; day < 364; day += 3) {
      const sample = new Date(from.getTime() + day * 86400000);
      // Ближайший реальный сброс: перебор минут вперёд на неделю.
      for (let m = 15; m <= 7 * 1440; m += 15) {
        const t = new Date(sample.getTime() + m * 60000);
        if (localPosition(t, config.timeZone) === config.resetDay * 1440 + config.resetMinutes) {
          for (let lead = 15; lead <= config.leadMinutes; lead += 15) {
            const at = new Date(t.getTime() - lead * 60000);
            expect(set.has(localPosition(at, mac))).toBe(true);
          }
          break;
        }
      }
    }
    return set;
  };

  it('разница поясов меньше запаса', () => {
    check({ resetDay: 2, resetMinutes: 1110, leadMinutes: 120, timeZone: 'Europe/Moscow' }, 'Europe/Berlin');
  });

  it('разница поясов больше запаса', () => {
    check({ resetDay: 2, resetMinutes: 1110, leadMinutes: 60, timeZone: 'Asia/Tokyo' }, 'America/New_York');
  });

  it('переход окна через полночь и неделю, разные даты перехода на летнее время', () => {
    const set = check({ resetDay: 0, resetMinutes: 30, leadMinutes: 120, timeZone: 'Europe/Berlin' }, 'America/Los_Angeles');
    expect([...set].some((m) => m >= 6 * 1440)).toBe(true);
  });

  it('без летнего времени в поясе Mac срабатывания дают сдвиг только от пояса сброса', () => {
    const set = check({ resetDay: 3, resetMinutes: 600, leadMinutes: 60, timeZone: 'Australia/Sydney' }, 'Asia/Tokyo');
    expect(set.size).toBeGreaterThanOrEqual(4);
  });
});

describe('lockVerdict', () => {
  const dead = () => false;
  const alive = () => true;
  it('живой pid — занято, мёртвый — устарела', () => {
    expect(lockVerdict({ pid: 10, pidAlive: alive, ageMs: LOCK_FRESH_MS * 10 })).toBe('busy');
    expect(lockVerdict({ pid: 10, pidAlive: dead, ageMs: 0 })).toBe('stale');
  });
  it('без pid-файла: свежая — занято, старая — устарела', () => {
    expect(lockVerdict({ pid: null, pidAlive: dead, ageMs: 1000 })).toBe('busy');
    expect(lockVerdict({ pid: null, pidAlive: dead, ageMs: LOCK_FRESH_MS + 1 })).toBe('stale');
  });
});

describe('агент на main', () => {
  it('сообщение просит закоммитить агента и скрипты в main', () => {
    expect(AGENT_MISSING_MESSAGE).toContain('.claude/agents/chapter-auditor.md');
    expect(AGENT_MISSING_MESSAGE).toContain('закоммитьте');
  });
});

describe('decide', () => {
  const config = { resetDay: 2, resetMinutes: 18 * 60 + 30, leadMinutes: 120 };
  const closedPlan = plan('- [x] 1. Всё.');
  const base = { config, planText: closedPlan, hasReport: () => false, state: {} };
  const inside = new Date(2026, 9, 27, 17, 0);

  it('внутри окна и глава закрыта: запуск', () => {
    expect(decide({ ...base, now: inside })).toMatchObject({ action: 'run', chapter: 'A' });
  });

  it('глава не закрыта, отчёт уже есть или в этом окне уже запускали: пропуск', () => {
    expect(decide({ ...base, now: inside, planText: plan('- [ ] 1. Всё.') }).action).toBe('skip');
    expect(decide({ ...base, now: inside, hasReport: () => true }).action).toBe('skip');
    const window = decide({ ...base, now: inside }).window.windowId;
    expect(decide({ ...base, now: inside, state: { lastWindow: window } }).action).toBe('skip');
  });

  it('вне окна пропуск, а после сброса сообщает о пропущенном окне', () => {
    expect(decide({ ...base, now: new Date(2026, 9, 27, 10, 0) }).action).toBe('skip');
    expect(decide({ ...base, now: new Date(2026, 9, 27, 19, 0) }).missedWindow).toBeTruthy();
  });
});

describe('разбор настроек', () => {
  it('день недели и время', () => {
    expect(parseWeekday('Tue')).toBe(2);
    expect(parseWeekday('вс')).toBe(0);
    expect(parseWeekday('9')).toBeNull();
    expect(parseClock('18:30')).toBe(1110);
    expect(parseClock('25:00')).toBeNull();
  });
});

describe('buildClaudeArgs', () => {
  const worktree = '/Users/me/.stream-announce-bot-audit/worktree-A';
  const args = buildClaudeArgs({ worktree });
  const value = (flag: string) => args[args.indexOf(flag) + 1];

  it('без отключения запросов разрешений и режимов обхода', () => {
    for (const forbidden of ['--dangerously-skip-permissions', '--permission-prompts', 'bypassPermissions', 'auto']) {
      expect(args).not.toContain(forbidden);
    }
    expect(value('--permission-mode')).toBe('dontAsk');
  });

  it('инструменты ограничены, Agent и MCP запрещены', () => {
    expect(value('--tools')).toBe('Read,Grep,Glob,Write');
    expect(value('--disallowedTools')).toBe('Agent');
    expect(args.some((a) => a.includes('mcp__'))).toBe(false);
    expect(args).toContain('--strict-mcp-config');
    expect(value('--model')).toBe('fable');
  });

  it('правило записи указывает только на каталог отчётов', () => {
    expect(value('--allowedTools')).toBe(`Edit(/${worktree}/docs/audits/**)`);
    expect(args.filter((a) => /Write\(|Bash/.test(a))).toEqual([]);
  });

  it('промпт называет главу и файл контекста', () => {
    const prompt = buildPrompt({ chapter: 'B', contextFile: '.audit-context.md' });
    expect(prompt).toContain('главы B');
    expect(prompt).toContain('.audit-context.md');
    expect(prompt).toContain('docs/audits/chapter-B.md');
  });
});

describe('auditOutcome', () => {
  const full = `# Отчёт\n\n${REPORT_COMPLETE_MARKER}\n`;
  it('успех: код 0 и полный отчёт', () => {
    expect(auditOutcome({ code: 0, timedOut: false, reportText: full }).ok).toBe(true);
  });
  it('неуспех: ненулевой код, таймаут, нет отчёта, нет метки', () => {
    expect(auditOutcome({ code: 1, timedOut: false, reportText: full }).ok).toBe(false);
    expect(auditOutcome({ code: 0, timedOut: true, reportText: full }).ok).toBe(false);
    expect(auditOutcome({ code: 0, timedOut: false, reportText: null }).ok).toBe(false);
    expect(auditOutcome({ code: 0, timedOut: false, reportText: '# Отчёт без метки' }).ok).toBe(false);
  });
  it('метка должна быть последней строкой', () => {
    expect(isReportComplete(`${REPORT_COMPLETE_MARKER}\nещё текст`)).toBe(false);
  });
});

describe('claudeDeadline', () => {
  const config = { resetDay: 2, resetMinutes: 18 * 60 + 30, leadMinutes: 120 };
  const at = (minutesBefore: number) => new Date(new Date(2026, 0, 6, 18, 30).getTime() - minutesBefore * 60000);
  it('до сброса достаточно времени: таймаут с запасом', () => {
    const result = claudeDeadline(at(60), config);
    expect(result.allowed).toBe(true);
    expect(result.timeoutMs).toBe(55 * 60000);
  });
  it('общий потолок ограничивает таймаут', () => {
    expect(claudeDeadline(at(100 * 60), config).timeoutMs).toBe(4 * 60 * 60000);
  });
  it('мало времени до сброса: отказ с причиной', () => {
    const result = claudeDeadline(at(10), config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('не запускается');
  });
  it('сброс только что прошёл: до следующего почти неделя, ограничивает потолок', () => {
    const result = claudeDeadline(at(-5), config);
    expect(result.allowed).toBe(true);
    expect(result.timeoutMs).toBe(4 * 60 * 60000);
  });
});

describe('decideManual', () => {
  const closed = plan('- [x] 1. Готово.');
  const open = plan('- [ ] 1. Не готово.');
  const none = () => false;
  it('отчёт уже есть: отказ, даже с флагом', () => {
    expect(decideManual({ chapter: 'A', planText: closed, hasReport: () => true, force: false }).action).toBe('refuse');
    expect(decideManual({ chapter: 'A', planText: open, hasReport: () => true, force: true }).action).toBe('refuse');
  });
  it('глава не закрыта: отказ без флага, запуск с флагом', () => {
    expect(decideManual({ chapter: 'A', planText: open, hasReport: none, force: false }).action).toBe('refuse');
    expect(decideManual({ chapter: 'A', planText: open, hasReport: none, force: true }).action).toBe('run');
  });
  it('всё в порядке: запуск', () => {
    expect(decideManual({ chapter: 'A', planText: closed, hasReport: none, force: false }).action).toBe('run');
  });
});
