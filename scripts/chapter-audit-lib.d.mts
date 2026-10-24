export interface ChapterTask {
  id: string;
  done: boolean;
}
export interface Chapter {
  id: string;
  tasks: ChapterTask[];
  closed: boolean;
}
export interface WindowConfig {
  resetDay: number;
  resetMinutes: number;
  leadMinutes: number;
  timeZone?: string;
}
export interface WindowInfo {
  state: 'before' | 'inside' | 'missed';
  windowId: string;
  minutesToReset: number;
}
export interface AuditState {
  lastWindow?: string;
  lastMissed?: string;
}
export interface Decision {
  action: 'run' | 'skip';
  window: WindowInfo;
  chapter?: string;
  reason: string;
  missedWindow?: string;
}
export function parseWeekday(value: string): number | null;
export function parseClock(value: string): number | null;
export function parseChapters(markdown: string): Chapter[];
export function findChapterToAudit(chapters: Chapter[], hasReport: (id: string) => boolean): string | null;
export function windowStatus(now: Date, config: WindowConfig): WindowInfo;
export function calendarIntervals(
  config: WindowConfig,
  options?: { stepMinutes?: number; from?: Date; localTimeZone?: string },
): Array<{ Weekday: number; Hour: number; Minute: number }>;
export function decide(input: {
  now: Date;
  config: WindowConfig;
  planText: string;
  hasReport: (id: string) => boolean;
  state: AuditState;
}): Decision;
export function reportAllowRule(worktree: string): string;
export function buildClaudeArgs(input: { worktree: string; maxTurns?: number }): string[];
export function buildPrompt(input: { chapter: string; contextFile: string }): string;
export const AGENT_PATH: string;
export const AGENT_MISSING_MESSAGE: string;
export const LOCK_FRESH_MS: number;
export function lockVerdict(input: { pid: number | null; pidAlive: (pid: number) => boolean; ageMs: number }): 'busy' | 'stale';
export const REPORT_COMPLETE_MARKER: string;
export function isReportComplete(text: string | null | undefined): boolean;
export function auditOutcome(input: { code: number | null; timedOut: boolean; reportText: string | null }): { ok: boolean; reason: string };
export const RESET_MARGIN_MINUTES: number;
export const MIN_RUN_MINUTES: number;
export const MAX_RUN_MINUTES: number;
export function claudeDeadline(
  now: Date,
  config: WindowConfig,
): { allowed: boolean; timeoutMs: number; minutesToReset: number; reason: string };
export function decideManual(input: {
  chapter: string;
  planText: string;
  hasReport: (id: string) => boolean;
  force: boolean;
}): { action: 'run' | 'refuse'; reason: string };
