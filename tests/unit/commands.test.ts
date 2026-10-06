import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/announcerHarness.js';
import { CommandListener } from '../../src/telegram/commands.js';
import type { TelegramClient, TelegramUpdate } from '../../src/telegram/client.js';

const ADMIN = 42;

let harness: Harness;

/** Прогоняет один апдейт через слушатель: getUpdates отдаёт его и останавливает цикл. */
async function deliver(message: NonNullable<TelegramUpdate['message']>): Promise<void> {
  const listener = new CommandListener({
    telegram: harness.telegram as unknown as TelegramClient,
    store: harness.store,
    announcer: harness.announcer,
    adminId: ADMIN,
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
