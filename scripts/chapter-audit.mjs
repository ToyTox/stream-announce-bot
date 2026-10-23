#!/usr/bin/env node
// Аудит глав A, B, C из docs/mobile-app-plan.md перед сбросом недельного лимита подписки Claude Code (только Mac).
// Когда глава закрыта на main и отчёта нет, LaunchAgent запускает claude с агентом chapter-auditor.
// Все git-операции делает этот скрипт до запуска модели: агент git не вызывает.
//
//   node scripts/chapter-audit.mjs install --day Tue --time 18:30 [--lead 120] [--tz Europe/Moscow]
//   node scripts/chapter-audit.mjs settings --lead 180        изменить настройки (переустанавливает LaunchAgent)
//   node scripts/chapter-audit.mjs uninstall
//   node scripts/chapter-audit.mjs run-now <A|B|C> [--force-open] [--dry-run]   запуск вручную, окно не проверяется;
//                                                                  --force-open разрешает незакрытую главу
//   node scripts/chapter-audit.mjs run [--dry-run]               то, что делает LaunchAgent
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_MISSING_MESSAGE,
  AGENT_PATH,
  buildClaudeArgs,
  auditOutcome,
  buildPrompt,
  calendarIntervals,
  claudeDeadline,
  decide,
  decideManual,
  lockVerdict,
  parseClock,
  parseWeekday,
} from './chapter-audit-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = join(homedir(), '.stream-announce-bot-audit');
const configFile = join(stateDir, 'config.json');
const stateFile = join(stateDir, 'state.json');
const logFile = join(stateDir, 'audit.log');
const lockDir = join(stateDir, 'lock');
const LABEL = 'com.stream-announce-bot.chapter-audit';
const plistFile = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const DEFAULT_DRY_CONFIG = { resetDay: 2, resetMinutes: 1110, leadMinutes: 120 };

function log(message) {
  mkdirSync(stateDir, { recursive: true });
  const line = `${new Date().toISOString()} ${message}`;
  appendFileSync(logFile, `${line}\n`);
  console.log(line);
}

function git(args, options = {}) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[name] = true;
      else {
        flags[name] = next;
        i++;
      }
    } else rest.push(argv[i]);
  }
  return { flags, rest };
}

function claudeAvailable() {
  return spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
}

function hasReport(id) {
  if (existsSync(join(repoRoot, 'docs', 'audits', `chapter-${id}.md`))) return true;
  try {
    git(['cat-file', '-e', `main:docs/audits/chapter-${id}.md`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function agentOnMain() {
  try {
    git(['cat-file', '-e', `main:${AGENT_PATH}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  mkdirSync(stateDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      return true;
    } catch {
      let pid = null;
      try {
        pid = Number(readFileSync(join(lockDir, 'pid'), 'utf8').trim()) || null;
      } catch {
        // файла pid ещё нет или он не читается: решает возраст блокировки
      }
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        // каталог уже исчез: следующая попытка создаст его заново
        continue;
      }
      const pidAlive = (value) => {
        try {
          process.kill(value, 0);
          return true;
        } catch {
          return false;
        }
      };
      if (lockVerdict({ pid, pidAlive, ageMs }) === 'busy') return false;
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return false;
}

function releaseLock() {
  rmSync(lockDir, { recursive: true, force: true });
}

function gitContext() {
  const parts = [
    `# Git-контекст main\n\nКоммит main: ${git(['rev-parse', 'main']).trim()}`,
    `## Последние коммиты (с изменёнными файлами)\n\n${git(['log', 'main', '-n', '80', '--date=short', '--stat', '--pretty=format:%n%h %ad %an: %s'])}`,
    `## Merge-коммиты задач\n\n${git(['log', 'main', '-n', '80', '--merges', '--date=short', '--pretty=format:%h %ad %s'])}`,
  ];
  return parts.join('\n\n').slice(0, 300_000);
}

function runClaude(args, prompt, cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, output: String(error), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output, timedOut });
    });
    child.stdin.end(prompt);
  });
}

async function audit(chapter, dryRun, config) {
  const worktree = join(stateDir, `worktree-${chapter}`);
  const contextName = '.audit-context.md';
  const args = buildClaudeArgs({ worktree });
  const prompt = buildPrompt({ chapter, contextFile: contextName });
  const deadline = claudeDeadline(new Date(), config);
  if (dryRun) {
    console.log(`Лимит времени: ${deadline.reason}`);
    console.log(`Команда: claude ${args.map((a) => JSON.stringify(a)).join(' ')}\nПромпт (stdin):\n${prompt}\nРабочая копия: ${worktree}`);
    return true;
  }
  if (!deadline.allowed) {
    log(`глава ${chapter}: ${deadline.reason}`);
    return false;
  }
  rmSync(worktree, { recursive: true, force: true });
  git(['worktree', 'prune']);
  git(['worktree', 'add', '--detach', worktree, 'main'], { stdio: 'ignore' });
  try {
    writeFileSync(join(worktree, contextName), gitContext());
    mkdirSync(join(worktree, 'docs', 'audits'), { recursive: true });
    log(`глава ${chapter}: запуск claude (модель fable), ${deadline.reason}`);
    const result = await runClaude(args, prompt, worktree, deadline.timeoutMs);
    log(`глава ${chapter}: claude завершился с кодом ${result.code}\n${result.output.trim()}`);
    const report = join(worktree, 'docs', 'audits', `chapter-${chapter}.md`);
    const target = join(repoRoot, 'docs', 'audits', `chapter-${chapter}.md`);
    const reportText = existsSync(report) ? readFileSync(report, 'utf8') : null;
    const outcome = auditOutcome({ code: result.code, timedOut: result.timedOut, reportText });
    if (!outcome.ok) {
      if (reportText != null) {
        const partial = join(stateDir, `partial-chapter-${chapter}.md`);
        writeFileSync(partial, reportText);
        log(`глава ${chapter}: частичный отчёт для диагностики сохранён в ${partial}`);
      }
      log(`глава ${chapter}: ${outcome.reason}, отчёт в docs/audits/ не перенесён, повтор в окне следующей недели`);
      return false;
    }
    if (existsSync(target)) {
      log(`глава ${chapter}: ${target} уже существует, отчёт не перезаписан`);
      return false;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(report, target);
    log(`глава ${chapter}: отчёт сохранён в ${target}`);
    return true;
  } finally {
    try {
      git(['worktree', 'remove', '--force', worktree], { stdio: 'ignore' });
    } catch {
      rmSync(worktree, { recursive: true, force: true });
      git(['worktree', 'prune']);
    }
  }
}

function missingClaude() {
  log('ошибка: команда claude не найдена в PATH. Установите Claude Code (https://code.claude.com) или заново выполните install в терминале, где claude работает.');
}

async function runManual(chapter, dryRun, force) {
  if (!'ABC'.includes(chapter) || chapter.length !== 1) {
    console.error('Укажите главу: A, B или C.');
    process.exit(1);
  }
  // Для сухого прогона настройки не обязательны (как у run): берётся вторник 18:30.
  const config = readJson(configFile, dryRun ? DEFAULT_DRY_CONFIG : null);
  if (!config) {
    console.error('Настройки не найдены. Выполните install.');
    process.exit(1);
  }
  if (!agentOnMain()) return log(AGENT_MISSING_MESSAGE), void (dryRun ? undefined : process.exit(1));
  const decision = decideManual({ chapter, planText: git(['show', 'main:docs/mobile-app-plan.md']), hasReport, force });
  if (dryRun) {
    console.log(`Решение: ${decision.action === 'run' ? 'run' : 'skip'}, ${decision.reason}`);
    if (decision.action === 'run') await audit(chapter, true, config);
    return;
  }
  if (decision.action !== 'run') {
    log(`глава ${chapter}: отказ, ${decision.reason}`);
    process.exit(1);
  }
  if (!claudeAvailable()) return missingClaude(), process.exit(1);
  if (!acquireLock()) return log('другой запуск аудита ещё идёт, выход'), void 0;
  try {
    log(`глава ${chapter}: ${decision.reason}`);
    await audit(chapter, false, config);
  } finally {
    releaseLock();
  }
}

async function runScheduled(dryRun) {
  // Для сухого прогона настройки не обязательны: берётся вторник 18:30 и запас 120 минут.
  const config = readJson(configFile, dryRun ? DEFAULT_DRY_CONFIG : null);
  if (!config) {
    console.error('Настройки не найдены. Выполните install.');
    process.exit(1);
  }
  if (!agentOnMain()) return void log(AGENT_MISSING_MESSAGE);
  const planText = git(['show', 'main:docs/mobile-app-plan.md']);
  const state = readJson(stateFile, {});
  const decision = decide({ now: new Date(), config, planText, hasReport, state });
  if (dryRun) {
    console.log(`Решение: ${decision.action}, ${decision.reason}`);
    if (decision.action === 'run') await audit(decision.chapter, true, config);
    return;
  }
  if (!acquireLock()) return void log('другой запуск аудита ещё идёт, выход');
  try {
    const fresh = readJson(stateFile, {});
    if (decision.missedWindow && fresh.lastMissed !== decision.missedWindow) {
      fresh.lastMissed = decision.missedWindow;
      writeFileSync(stateFile, JSON.stringify(fresh));
      log(`окно ${decision.missedWindow} пропущено (спящий Mac или выключено), лимит новой недели не тратим`);
    }
    if (decision.action === 'skip') return;
    if (fresh.lastWindow === decision.window.windowId) return;
    if (!claudeAvailable()) return missingClaude();
    // Окно помечаем до запуска: упавший запуск повторяется только в окне следующей недели.
    writeFileSync(stateFile, JSON.stringify({ ...fresh, lastWindow: decision.window.windowId }));
    log(`окно ${decision.window.windowId}: ${decision.reason}`);
    await audit(decision.chapter, false, config);
  } finally {
    releaseLock();
  }
}

function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function install(flags) {
  const old = readJson(configFile, {});
  const day = flags.day === undefined ? old.resetDay : parseWeekday(flags.day);
  const minutes = flags.time === undefined ? old.resetMinutes : parseClock(flags.time);
  const lead = flags.lead === undefined ? (old.leadMinutes ?? 120) : Number(flags.lead);
  if (day == null || minutes == null || !(lead >= 15)) {
    console.error('Нужно: --day <Mon..Sun|пн..вс|0-6> --time <ЧЧ:ММ> [--lead <минуты, от 15, по умолчанию 120>] [--tz <часовой пояс>]');
    process.exit(1);
  }
  const config = { resetDay: day, resetMinutes: minutes, leadMinutes: lead };
  const timeZone = flags.tz === undefined ? old.timeZone : flags.tz;
  if (timeZone && timeZone !== true) config.timeZone = timeZone;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  const schedule = calendarIntervals(config);
  const intervals = schedule
    .map((i) => `    <dict><key>Weekday</key><integer>${i.Weekday}</integer><key>Hour</key><integer>${i.Hour}</integer><key>Minute</key><integer>${i.Minute}</integer></dict>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(fileURLToPath(import.meta.url))}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xmlEscape(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, plist);
  const domain = `gui/${process.getuid()}`;
  spawnSync('launchctl', ['bootout', domain, plistFile], { stdio: 'ignore' });
  const result = spawnSync('launchctl', ['bootstrap', domain, plistFile], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`launchctl bootstrap завершился с ошибкой. Файл ${plistFile} записан, загрузите его вручную.`);
    process.exit(1);
  }
  console.log(`LaunchAgent установлен: сброс ${JSON.stringify(config)}, срабатываний за неделю: ${schedule.length}.`);
  if (config.timeZone) {
    console.log(`Расписание переведено из пояса ${config.timeZone} в пояс Mac с учётом перехода на летнее время на год вперёд. Переустановите (install) не позже чем через год, а также после смены пояса Mac.`);
  }
  console.log('Если Mac спит в окне запуска, аудит пропускается и переносится на следующую неделю. Чтобы не спал: pmset repeat wakeorpoweron — команда требует sudo, выполните её сами (man pmset).');
  if (!claudeAvailable()) console.log('Предупреждение: команда claude не найдена в PATH.');
}

function uninstall() {
  const domain = `gui/${process.getuid()}`;
  spawnSync('launchctl', ['bootout', domain, plistFile], { stdio: 'ignore' });
  rmSync(plistFile, { force: true });
  console.log(`LaunchAgent удалён. Настройки, состояние и лог остались в ${stateDir}.`);
}

const { flags, rest } = parseFlags(process.argv.slice(2));
const command = rest[0] ?? 'run';
if (command === 'install' || command === 'settings') install(flags);
else if (command === 'uninstall') uninstall();
else if (command === 'run-now') await runManual(String(rest[1] ?? '').toUpperCase(), Boolean(flags['dry-run']), Boolean(flags['force-open']));
else if (command === 'run') await runScheduled(Boolean(flags['dry-run']));
else {
  console.error('Команды: install, settings, uninstall, run-now <A|B|C> [--force-open], run. Подробности в начале scripts/chapter-audit.mjs.');
  process.exit(1);
}
