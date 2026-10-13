import axios, { AxiosInstance } from 'axios';

/**
 * Тонкий клиент вебхука Discord. Как и у Telegram, наружу отдаёт типизированную ошибку:
 * announcer должен отличать «не ушло, попробуем в следующий тик» от «вебхук неверный,
 * повторять бессмысленно». Discord банит за поток невалидных запросов, поэтому
 * 400, 401, 403 и 404 не повторяем ни здесь, ни в следующих тиках.
 */

export type DiscordErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'bad_request'
  | 'rejected'
  | 'bad_response'
  | 'rate_limited'
  | 'upstream';

export class DiscordError extends Error {
  constructor(
    readonly code: DiscordErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DiscordError';
  }

  /** Есть ли смысл повторять операцию позже. */
  get retriable(): boolean {
    return this.code === 'rate_limited' || this.code === 'upstream';
  }
}

export interface DiscordEmbed {
  description: string;
  image?: { url: string };
}

export interface DiscordPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

export interface DiscordMessage {
  id: string;
}

const REQUEST_TIMEOUT = 15_000;
const MAX_ATTEMPTS = 3;
/** Дольше ждать внутри одного вызова не будем: повторит следующий тик. */
const MAX_INLINE_WAIT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ApiErrorBody {
  message?: string;
  /** Секунды, бывает дробным. */
  retry_after?: number;
}

export class DiscordClient {
  private readonly http: AxiosInstance;

  constructor(private readonly webhookUrl: string) {
    this.http = axios.create({ timeout: REQUEST_TIMEOUT });
  }

  /** wait=true: Discord отвечает объектом сообщения — только по нему считаем доставку подтверждённой. */
  async send(payload: DiscordPayload): Promise<DiscordMessage> {
    const body = {
      ...payload,
      // Пустой parse: @everyone и @here из названия стрима не должны пинговать сервер.
      allowed_mentions: { parse: [] as string[] },
    };
    let lastError: DiscordError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let waitMs = 1000 * attempt;
      try {
        const response = await this.http.post<Partial<DiscordMessage> | undefined>(
          `${this.webhookUrl}?wait=true`,
          body
        );
        const id = response.data?.id;
        if (typeof id !== 'string' || id === '') {
          throw new DiscordError('bad_response', 'webhook: Discord не вернул сообщение — доставка не подтверждена');
        }
        return { id };
      } catch (error) {
        lastError = toDiscordError(error);
        if (!lastError.retriable || attempt === MAX_ATTEMPTS) break;
        waitMs = retryDelayMs(error, waitMs);
        if (waitMs > MAX_INLINE_WAIT_MS) break;
        await delay(waitMs);
      }
    }

    throw lastError ?? new DiscordError('upstream', 'webhook: неизвестная ошибка');
  }
}

function errorBody(error: unknown): ApiErrorBody | undefined {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as unknown;
    return data && typeof data === 'object' ? (data as ApiErrorBody) : undefined;
  }
  return undefined;
}

function retryDelayMs(error: unknown, fallbackMs: number): number {
  const retryAfter = errorBody(error)?.retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.ceil(retryAfter * 1000);
  }
  return fallbackMs;
}

export function toDiscordError(error: unknown): DiscordError {
  if (error instanceof DiscordError) return error;
  const description = errorBody(error)?.message ?? (error instanceof Error ? error.message : String(error));
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;

  if (status === 429) {
    return new DiscordError('rate_limited', `webhook: лимит Discord (${description})`);
  }
  if (status === 401) {
    return new DiscordError('unauthorized', `webhook: Discord отклонил токен вебхука (${description})`);
  }
  if (status === 404) {
    return new DiscordError('not_found', `webhook: вебхук не найден — возможно, удалён; проверьте DISCORD_WEBHOOK_URL (${description})`);
  }
  if (status === 400) {
    return new DiscordError('bad_request', `webhook: Discord не принял сообщение (${description})`);
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return new DiscordError('rejected', `webhook: HTTP ${status} (${description})`);
  }
  return new DiscordError('upstream', `webhook: ${description}`);
}
