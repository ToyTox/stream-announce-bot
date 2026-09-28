import axios, { AxiosInstance } from 'axios';

/**
 * Тонкий клиент Bot API. Наружу отдаёт только то, что нужно боту, и типизированную
 * ошибку: announcer должен отличать «не ушло, попробуем в следующий тик» от
 * «конфиг неверный, дальше бессмысленно».
 */

export type TelegramErrorCode = 'unauthorized' | 'chat_not_found' | 'rate_limited' | 'upstream';

export class TelegramError extends Error {
  constructor(
    readonly code: TelegramErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TelegramError';
  }

  /** Есть ли смысл повторять операцию позже. */
  get retriable(): boolean {
    return this.code === 'rate_limited' || this.code === 'upstream';
  }
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number | string };
  text?: string;
  caption?: string;
  from?: { id: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage & { from?: { id: number }; text?: string };
}

export interface SendOptions {
  /** Тема форума; не передаётся, если TELEGRAM_TOPIC_ID пуст. */
  messageThreadId?: number;
}

const REQUEST_TIMEOUT = 15_000;
const MAX_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ApiErrorBody {
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  private readonly http: AxiosInstance;

  constructor(
    botToken: string,
    private readonly chatId: string,
    private readonly topicId?: number
  ) {
    this.http = axios.create({
      baseURL: `https://api.telegram.org/bot${botToken}`,
      timeout: REQUEST_TIMEOUT,
    });
  }

  private threadPayload(options?: SendOptions): Record<string, unknown> {
    const threadId = options?.messageThreadId ?? this.topicId;
    return threadId === undefined ? {} : { message_thread_id: threadId };
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    let lastError: TelegramError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.http.post<{ ok: boolean; result: T }>(method, payload);
        return response.data.result;
      } catch (error) {
        lastError = toTelegramError(error, method);
        if (!lastError.retriable || attempt === MAX_ATTEMPTS) break;
        await delay(retryDelayMs(error, attempt));
      }
    }

    throw lastError ?? new TelegramError('upstream', `${method}: неизвестная ошибка`);
  }

  async sendMessage(text: string, options?: SendOptions): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      // Ссылки уже есть в тексте; отдельная карточка предпросмотра только мешает.
      link_preview_options: { is_disabled: true },
      ...this.threadPayload(options),
    });
  }

  async sendPhoto(photoUrl: string, caption: string, options?: SendOptions): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendPhoto', {
      chat_id: this.chatId,
      photo: photoUrl,
      caption,
      parse_mode: 'HTML',
      ...this.threadPayload(options),
    });
  }

  async editMessageCaption(messageId: number, caption: string): Promise<void> {
    await this.call('editMessageCaption', {
      chat_id: this.chatId,
      message_id: messageId,
      caption,
      parse_mode: 'HTML',
    });
  }

  async editMessageText(messageId: number, text: string): Promise<void> {
    await this.call('editMessageText', {
      chat_id: this.chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  /** Long polling: таймаут запроса даём с запасом над timeout самого getUpdates. */
  async getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const response = await this.http.post<{ ok: boolean; result: TelegramUpdate[] }>(
      'getUpdates',
      {
        ...(offset === undefined ? {} : { offset }),
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      },
      { timeout: (timeoutSeconds + 10) * 1000 }
    );
    return response.data.result;
  }

  async sendTo(userId: number, text: string): Promise<void> {
    await this.call('sendMessage', {
      chat_id: userId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }
}

function errorBody(error: unknown): ApiErrorBody | undefined {
  if (axios.isAxiosError(error)) {
    return error.response?.data as ApiErrorBody | undefined;
  }
  return undefined;
}

function retryDelayMs(error: unknown, attempt: number): number {
  const retryAfter = errorBody(error)?.parameters?.retry_after;
  if (typeof retryAfter === 'number') return retryAfter * 1000;
  return 1000 * attempt;
}

export function toTelegramError(error: unknown, method: string): TelegramError {
  const body = errorBody(error);
  const description = body?.description ?? (error instanceof Error ? error.message : String(error));
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;

  if (status === 401) {
    return new TelegramError('unauthorized', `${method}: неверный TELEGRAM_BOT_TOKEN (${description})`);
  }
  if (status === 429) {
    return new TelegramError('rate_limited', `${method}: лимит Telegram (${description})`);
  }
  if (status === 400 && /chat not found|chat_id/i.test(description)) {
    return new TelegramError(
      'chat_not_found',
      `${method}: чат не найден — проверьте TELEGRAM_CHAT_ID и что бот добавлен в группу (${description})`
    );
  }
  return new TelegramError('upstream', `${method}: ${description}`);
}
