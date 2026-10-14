import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/announcerHarness.js';
import { CommandListener } from '../../src/telegram/commands.js';
import type { TelegramClient, TelegramUpdate } from '../../src/telegram/client.js';

const ADMIN = 42;

let harness: Harness;

/** Прогоняет один апдейт через слушатель: getUpdates отдаёт его и останавливает цикл. */
async function deliver(message: NonNullable<TelegramUpdate['message']>, language = 'ru'): Promise<void> {
  const listener = new CommandListener({
    telegram: harness.telegram as unknown as TelegramClient,
    store: harness.store,
    announcer: harness.announcer,
    adminId: ADMIN,
    language: () => language,
  });
  harness.telegram.getUpdates.mockImplementationOnce(async () => {
    listener.stop();
    return [{ update_id: 1, message }] as never;
  });
  listener.start();
  await vi.waitFor(() => expect(harness.store.updatesOffset()).toBe(2));
}

function chat(extra: Partial<NonNullable<TelegramUpdate['message']>>) {
  return { message_id: 1, chat: { id: ADMIN }, from: { id: ADMIN }, ...extra };
}

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

describe('CommandListener: превью', () => {
  it('фото от владельца сохраняется самым крупным размером', async () => {
    await deliver(
      chat({
        photo: [
          { file_id: 'small', width: 90, height: 51 },
          { file_id: 'large', width: 1280, height: 720 },
        ],
      })
    );

    expect(harness.store.announcePhoto()).toBe('large');
  });

  it('фото от чужого игнорируется', async () => {
    await deliver(chat({ from: { id: 7 }, photo: [{ file_id: 'x', width: 1, height: 1 }] }));

    expect(harness.store.announcePhoto()).toBeNull();
  });

  it('/image - сбрасывает превью', async () => {
    harness.store.setAnnouncePhoto('large');

    await deliver(chat({ text: '/image -' }));

    expect(harness.store.announcePhoto()).toBeNull();
  });

  it('/image_clear сбрасывает превью так же, как /image -', async () => {
    harness.store.setAnnouncePhoto('large');

    await deliver(chat({ text: '/image_clear' }));

    expect(harness.store.announcePhoto()).toBeNull();
  });
});

describe('CommandListener: язык ответов', () => {
  const lastReply = () => harness.telegram.sendTo.mock.calls.at(-1)!.at(1) as unknown as string;

  it('справка и ответы на русском по умолчанию', async () => {
    await deliver(chat({ text: '/help' }));
    expect(lastReply()).toContain('<b>Команды</b>');

    await deliver(chat({ text: '/text' }));
    expect(lastReply()).toContain('Врезка не задана');
  });

  it('справка и ответы на английском, сами команды те же', async () => {
    await deliver(chat({ text: '/help' }), 'en');
    expect(lastReply()).toContain('<b>Commands</b>');
    expect(lastReply()).toContain('/image_clear');

    await deliver(chat({ text: '/text Hello <b>' }), 'en');
    expect(lastReply()).toBe('Insert saved, it will go into the next announcement:\nHello &lt;b&gt;');

    await deliver(chat({ text: '/image -' }), 'en');
    expect(lastReply()).toContain('Custom preview cleared');

    await deliver(chat({ text: '/status' }), 'en');
    expect(lastReply()).toBe('Not live right now.');
  });

  it('язык берётся при каждом ответе, а не при создании слушателя', async () => {
    let language = 'ru';
    const listener = new CommandListener({
      telegram: harness.telegram as unknown as TelegramClient,
      store: harness.store,
      announcer: harness.announcer,
      adminId: ADMIN,
      language: () => language,
    });
    harness.telegram.getUpdates.mockImplementationOnce(async () => {
      language = 'en';
      listener.stop();
      return [{ update_id: 1, message: chat({ text: '/status' }) }] as never;
    });
    listener.start();
    await vi.waitFor(() => expect(harness.store.updatesOffset()).toBe(2));

    expect(lastReply()).toBe('Not live right now.');
  });
});
