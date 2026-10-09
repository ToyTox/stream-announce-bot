import type { Announcer } from '../announcer.js';
import type { Store } from '../store.js';
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
}

const HELP = [
  '<b>Команды</b>',
  '/text &lt;текст&gt; — врезка в следующий анонс',
  '/text — показать текущую врезку',
  '/text - — сбросить врезку',
  'Фото — превью для всех анонсов вместо превью Twitch',
  '/image — есть ли своё превью',
  '/image - или /image_clear — сбросить превью',
  '/status — что сейчас в эфире',
  '/help — эта справка',
].join('\n');

export class CommandListener {
  private running = false;
  private abort = new AbortController();
  private loopDone: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CommandListenerDeps) {}

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
      await this.reply('Превью сохранено — будет во всех анонсах вместо превью Twitch, пока не замените или не сбросите командой /image -.');
      return;
    }
    if (message.document?.mime_type?.startsWith('image/')) {
      // sendPhoto не принимает file_id документа — нужна картинка, отправленная как фото.
      await this.reply('Это картинка-файл. Отправьте её как фото, со сжатием.');
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
        await this.reply(HELP);
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
          ? `Врезка для следующего анонса:\n${escapeForReply(current)}`
          : 'Врезка не задана. Отправьте «/text ваш текст», чтобы добавить её в следующий анонс.'
      );
      return;
    }

    if (argument === '-') {
      this.deps.store.clearAnnounceText();
      await this.reply('Врезка сброшена.');
      return;
    }

    this.deps.store.setAnnounceText(argument);
    await this.reply(`Врезка сохранена, уйдёт в следующий анонс:\n${escapeForReply(argument)}`);
  }

  private async handleImage(argument: string): Promise<void> {
    if (argument === '-') {
      this.deps.store.clearAnnouncePhoto();
      await this.reply('Своё превью сброшено — в анонсе будет превью Twitch.');
      return;
    }
    await this.reply(
      this.deps.store.announcePhoto()
        ? 'Своё превью задано и используется во всех анонсах. «/image -» — сбросить.'
        : 'Своё превью не задано — в анонсе будет превью Twitch. Пришлите фото, чтобы заменить.'
    );
  }

  private statusText(): string {
    const status = this.deps.announcer.status();
    if (!status) return 'Сейчас эфира нет.';
    const platforms =
      status.platforms.length > 0
        ? status.platforms.map((platform) => PLATFORM_LABELS[platform]).join(', ')
        : 'платформы проверяются';
    const startedAt = new Date(status.startedAt).toLocaleString('ru-RU');
    return `В эфире: ${platforms}\nНачало: ${startedAt}`;
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
