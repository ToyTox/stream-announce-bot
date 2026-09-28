import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramClient, TelegramError } from '../../src/telegram/client.js';

const post = vi.fn();

vi.mock('axios', () => ({
  default: {
    create: () => ({ post }),
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
  },
}));

function axiosError(status: number, body: unknown) {
  return { isAxiosError: true, response: { status, data: body }, message: `status ${status}` };
}

beforeEach(() => {
  post.mockReset();
  vi.useRealTimers();
});

describe('TelegramClient', () => {
  it('шлёт сообщение в нужный чат с HTML', async () => {
    post.mockResolvedValue({ data: { ok: true, result: { message_id: 7 } } });

    const message = await new TelegramClient('token', '-100123').sendMessage('<b>привет</b>');

    expect(message.message_id).toBe(7);
    expect(post).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      chat_id: '-100123',
      text: '<b>привет</b>',
      parse_mode: 'HTML',
    }));
  });

  it('не передаёт message_thread_id, если тема не задана', async () => {
    post.mockResolvedValue({ data: { ok: true, result: { message_id: 1 } } });

    await new TelegramClient('token', '-100123').sendMessage('тест');

    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('message_thread_id');
  });

  it('передаёт message_thread_id для группы-форума', async () => {
    post.mockResolvedValue({ data: { ok: true, result: { message_id: 1 } } });

    await new TelegramClient('token', '-100123', 42).sendPhoto('https://cdn/a.jpg', 'подпись');

    expect(post.mock.calls[0]?.[1]).toMatchObject({ message_thread_id: 42, photo: 'https://cdn/a.jpg' });
  });

  it('повторяет запрос после 429 и уважает retry_after', async () => {
    vi.useFakeTimers();
    post
      .mockRejectedValueOnce(axiosError(429, { description: 'Too Many Requests', parameters: { retry_after: 1 } }))
      .mockResolvedValueOnce({ data: { ok: true, result: { message_id: 9 } } });

    const promise = new TelegramClient('token', '-100123').sendMessage('тест');
    await vi.advanceTimersByTimeAsync(1000);

    expect((await promise).message_id).toBe(9);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('распознаёт неверный токен и не повторяет запрос', async () => {
    post.mockRejectedValue(axiosError(401, { description: 'Unauthorized' }));

    await expect(new TelegramClient('bad', '-100123').sendMessage('тест')).rejects.toMatchObject({
      name: 'TelegramError',
      code: 'unauthorized',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('распознаёт отсутствие чата', async () => {
    post.mockRejectedValue(axiosError(400, { description: 'Bad Request: chat not found' }));

    const error = await new TelegramClient('token', '-100123')
      .sendMessage('тест')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelegramError);
    expect((error as TelegramError).code).toBe('chat_not_found');
    expect((error as TelegramError).retriable).toBe(false);
  });
});
