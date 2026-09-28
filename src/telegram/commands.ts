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
  '/status — что сейчас в эфире',
  '/help — эта справка',
].join('\n');

export class CommandListener {
  private running = false;

  constructor(private readonly deps: CommandListenerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const offset = this.deps.store.updatesOffset() ?? undefined;
        const updates = await this.deps.telegram.getUpdates(offset, POLL_TIMEOUT_SECONDS);
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
        await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
      }
    }
  }

  /** Апдейты не от владельца игнорируются молча — бот может состоять в общих чатах. */
  private async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim();
    if (!message || !text || message.from?.id !== this.deps.adminId) return;

    const [rawCommand = '', ...rest] = text.split(/\s+/);
    // В группах команды приходят как /text@my_bot.
    const command = rawCommand.split('@')[0]?.toLowerCase();
    const argument = rest.join(' ').trim();

    switch (command) {
      case '/text':
        await this.handleText(argument);
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
