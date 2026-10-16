import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordClient, DiscordError } from '../../src/discord/client.js';

const post = vi.fn();

vi.mock('axios', () => ({
  default: {
    create: () => ({ post }),
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
  },
}));

const HOOK = 'https://discord.com/api/webhooks/1/secret-token';

function axiosError(status: number, body: unknown) {
  return { isAxiosError: true, response: { status, data: body }, message: `status ${status}` };
}

const payload = { embeds: [{ description: 'привет' }] };

beforeEach(() => {
  post.mockReset();
  vi.useRealTimers();
});

describe('DiscordClient', () => {
  it('шлёт на вебхук с wait=true и пустым allowed_mentions.parse', async () => {
    post.mockResolvedValue({ data: { id: '555' } });

    const message = await new DiscordClient(HOOK).send(payload);

    expect(message.id).toBe('555');
    expect(post).toHaveBeenCalledWith(`${HOOK}?wait=true`, {
      embeds: [{ description: 'привет' }],
      allowed_mentions: { parse: [] },
    });
  });

  it('ответ без объекта сообщения не считается доставкой и не повторяется', async () => {
    post.mockResolvedValue({ status: 204, data: '' });

    const error = await new DiscordClient(HOOK).send(payload).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiscordError);
    expect((error as DiscordError).retriable).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('повторяет после 429 и ждёт дробный retry_after', async () => {
    vi.useFakeTimers();
    post
      .mockRejectedValueOnce(axiosError(429, { message: 'You are being rate limited.', retry_after: 0.5 }))
      .mockResolvedValueOnce({ data: { id: '9' } });

    const promise = new DiscordClient(HOOK).send(payload);
    await vi.advanceTimersByTimeAsync(499);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await promise).id).toBe('9');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('слишком долгий retry_after не блокирует тик: ошибка временная, ждать не будем', async () => {
    post.mockRejectedValue(axiosError(429, { retry_after: 600 }));

    const error = await new DiscordClient(HOOK).send(payload).catch((caught: unknown) => caught);

    expect((error as DiscordError).code).toBe('rate_limited');
    expect((error as DiscordError).retriable).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('повторяет после 5xx и сети', async () => {
    vi.useFakeTimers();
    post
      .mockRejectedValueOnce(axiosError(502, {}))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ data: { id: '1' } });

    const promise = new DiscordClient(HOOK).send(payload);
    await vi.advanceTimersByTimeAsync(3000);

    expect((await promise).id).toBe('1');
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('после трёх неудач отдаёт временную ошибку', async () => {
    vi.useFakeTimers();
    post.mockRejectedValue(axiosError(500, {}));

    const promise = new DiscordClient(HOOK).send(payload).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(((await promise) as DiscordError).retriable).toBe(true);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it.each([
    [404, 'not_found'],
    [401, 'unauthorized'],
    [400, 'bad_request'],
    [403, 'rejected'],
  ])('HTTP %i — постоянная ошибка %s, без повторов', async (status, code) => {
    post.mockRejectedValue(axiosError(status, { message: 'Unknown Webhook', code: 10015 }));

    const error = await new DiscordClient(HOOK).send(payload).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiscordError);
    expect((error as DiscordError).code).toBe(code);
    expect((error as DiscordError).retriable).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('токен вебхука не попадает в текст ошибки', async () => {
    post.mockRejectedValue(axiosError(404, { message: 'Unknown Webhook' }));

    const error = await new DiscordClient(HOOK).send(payload).catch((caught: unknown) => caught);

    expect((error as DiscordError).message).not.toContain('secret-token');
  });

  describe('с вложением', () => {
    const file = { name: 'announce.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) };
    const withImage = { embeds: [{ description: 'привет', image: { url: 'attachment://announce.png' } }] };

    it('шлёт multipart: payload_json с attachments и allowed_mentions, файл в files[0]', async () => {
      post.mockResolvedValue({ data: { id: '7' } });

      const message = await new DiscordClient(HOOK).send(withImage, file);

      expect(message.id).toBe('7');
      const [url, form] = post.mock.calls[0] as [string, FormData];
      expect(url).toBe(`${HOOK}?wait=true`);
      expect(form).toBeInstanceOf(FormData);
      expect(JSON.parse(form.get('payload_json') as string)).toEqual({
        ...withImage,
        allowed_mentions: { parse: [] },
        attachments: [{ id: 0, filename: 'announce.png' }],
      });
      const part = form.get('files[0]') as File;
      expect(part.name).toBe('announce.png');
      expect(part.type).toBe('image/png');
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(file.data);
    });

    it('повторяет после 429 и 5xx, собирая форму заново', async () => {
      vi.useFakeTimers();
      post
        .mockRejectedValueOnce(axiosError(429, { retry_after: 0.1 }))
        .mockRejectedValueOnce(axiosError(502, {}))
        .mockResolvedValueOnce({ data: { id: '8' } });

      const promise = new DiscordClient(HOOK).send(withImage, file);
      await vi.advanceTimersByTimeAsync(5000);

      expect((await promise).id).toBe('8');
      expect(post).toHaveBeenCalledTimes(3);
      const forms = post.mock.calls.map((call) => call[1] as FormData);
      expect(new Set(forms).size).toBe(3);
      expect(await (forms[2]!.get('files[0]') as File).arrayBuffer()).toHaveProperty('byteLength', 3);
    });

    it('без файла уходит JSON, как раньше', async () => {
      post.mockResolvedValue({ data: { id: '1' } });

      await new DiscordClient(HOOK).send(payload);

      expect(post.mock.calls[0]?.[1]).not.toBeInstanceOf(FormData);
    });
  });
});
