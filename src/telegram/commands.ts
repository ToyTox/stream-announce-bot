import type { Announcer } from '../announcer.js';
import type { Store } from '../store.js';
import { t, type Lang } from '../i18n/index.js';
import { PLATFORM_LABELS } from '../types.js';
import { TelegramClient, TelegramError, TelegramUpdate } from './client.js';

/**
 * Long polling вместо вебхука: вебхук требует публичный HTTPS, а бот крутится
 * локально. Offset держим в базе, чтобы после рестарта не переигрывать команды.
 */
const POLL_TIMEOUT_SECONDS = 30;
const ERROR_BACKOFF_MS = 5_000;

export interface CommandListenerDeps {
  telegram: TelegramClient;
  store: Store;
  announcer: Announcer;
  adminId: number;
  /** Язык ответов; функция, потому что его можно сменить в панели, не перезапуская бота. */
  language: () => Lang;
}

export class CommandListener {
  private running = false;
  private abort = new AbortController();
  private loopDone: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CommandListenerDeps) {}

  private t(key: string, params?: Record<string, string | number>): string {
    return t(this.deps.language(), key, params);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loopDone = this.loop();
  }

  /** Обрывает висящий getUpdates и ждёт выхода из цикла — после этого базу можно закрывать. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loopDone;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const offset = this.deps.store.updatesOffset() ?? undefined;
        const updates = await this.deps.telegram.getUpdates(
          offset,
          POLL_TIMEOUT_SECONDS,
          this.abort.signal
        );
        for (const update of updates) {
          this.deps.store.setUpdatesOffset(update.update_id + 1);
          await this.handle(update);
        }
      } catch (error) {
        if (!this.running) return;
        if (error instanceof TelegramError && error.code === 'unauthorized') {
          console.error('❌ Слушатель команд остановлен:', error.message);
          this.running = false;
          return;
        }
        console.warn(
          '⚠️  Опрос команд сорвался, повтор через 5 с:',
          error instanceof Error ? error.message : error
        );
        await this.pause(ERROR_BACKOFF_MS);
      }
    }
  }

  /** Пауза, которую прерывает stop(): иначе выключение ждало бы её до конца. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Апдейты не от владельца игнорируются молча — бот может состоять в общих чатах. */
  private async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || message.from?.id !== this.deps.adminId) return;

    const photo = message.photo?.at(-1);
    if (photo) {
      this.deps.store.setAnnouncePhoto(photo.file_id);
      await this.reply(this.t('cmd.photoSaved'));
      return;
    }
    if (message.document?.mime_type?.startsWith('image/')) {
      // sendPhoto не принимает file_id документа — нужна картинка, отправленная как фото.
      await this.reply(this.t('cmd.imageFile'));
      return;
    }

    const text = message.text?.trim();
    if (!text) return;

    const [rawCommand = '', ...rest] = text.split(/\s+/);
    // В группах команды приходят как /text@my_bot.
    const command = rawCommand.split('@')[0]?.toLowerCase();
    const argument = rest.join(' ').trim();

    switch (command) {
      case '/text':
        await this.handleText(argument);
        return;
      case '/image':
        await this.handleImage(argument);
        return;
      // Отдельная команда для меню BotFather: туда нельзя добавить команду с аргументом.
      case '/image_clear':
        await this.handleImage('-');
        return;
      case '/status':
        await this.reply(this.statusText());
        return;
      case '/help':
      case '/start':
        await this.reply(this.t('cmd.help'));
        return;
      default:
        return;
    }
  }

  private async handleText(argument: string): Promise<void> {
    if (!argument) {
      const current = this.deps.store.announceText();
      await this.reply(
        current
          ? this.t('cmd.textCurrent', { text: escapeForReply(current) })
          : this.t('cmd.textNone')
      );
      return;
    }

    if (argument === '-') {
      this.deps.store.clearAnnounceText();
      await this.reply(this.t('cmd.textCleared'));
      return;
    }

    this.deps.store.setAnnounceText(argument);
    await this.reply(this.t('cmd.textSaved', { text: escapeForReply(argument) }));
  }

  private async handleImage(argument: string): Promise<void> {
    if (argument === '-') {
      this.deps.store.clearAnnouncePhoto();
      await this.reply(this.t('cmd.imageCleared'));
      return;
    }
    await this.reply(
      this.deps.store.announcePhoto()
        ? this.t('cmd.imageSet')
        : this.t('cmd.imageNotSet')
    );
  }

  private statusText(): string {
    const status = this.deps.announcer.status();
    if (!status) return this.t('cmd.statusNone');
    const platforms =
      status.platforms.length > 0
        ? status.platforms.map((platform) => PLATFORM_LABELS[platform]).join(', ')
        : this.t('cmd.statusChecking');
    const startedAt = new Date(status.startedAt).toLocaleString(this.t('locale'));
    return this.t('cmd.statusLive', { platforms, startedAt });
  }

  private async reply(text: string): Promise<void> {
    try {
      await this.deps.telegram.sendTo(this.deps.adminId, text);
    } catch (error) {
      console.warn('⚠️  Не удалось ответить на команду:', error);
    }
  }
}

function escapeForReply(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
