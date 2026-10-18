import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';

/**
 * Локальная копия своей картинки анонса. file_id живёт в базе (Store), а байты —
 * файлом рядом с ней: Discord не читает file_id Telegram, и ходить за картинкой
 * в Telegram на каждый анонс незачем. Тип хранится вместе с байтами: из панели
 * приходит png/webp, а Telegram отдаёт jpeg. Без Telegram (или без админа) картинка
 * из панели существует только как локальный файл: вместо file_id в базе лежит метка LOCAL_PREFIX.
 */

export interface StoredImage {
  data: Uint8Array;
  type: string;
}

/** Всё, что нужно от Telegram: скачать файл по file_id. */
export interface FileDownloader {
  downloadFile(fileId: string): Promise<Uint8Array>;
}

interface Meta {
  fileId: string;
  type: string;
}

const DATA_FILE = 'announce-image.bin';
const META_FILE = 'announce-image.json';
/** Фото Telegram всегда пережимает в JPEG. */
const TELEGRAM_TYPE = 'image/jpeg';
/** Метка в базе вместо file_id: картинка есть только на диске. */
const LOCAL_PREFIX = 'local:';

export class AnnounceImage {
  private readonly dataPath: string;
  private readonly metaPath: string;
  /** Одна докачка на file_id: анонс и панель не должны качать один файл дважды. */
  private downloading: { fileId: string; promise: Promise<StoredImage> } | null = null;

  constructor(
    private readonly dir: string,
    private readonly store: Store,
    /** Нет, если Telegram выключен: докачать по file_id тогда неоткуда. */
    private readonly telegram?: FileDownloader
  ) {
    this.dataPath = join(dir, DATA_FILE);
    this.metaPath = join(dir, META_FILE);
  }

  /** Запоминает file_id; копия, если она есть, сохраняется вместе с ним, а старая стирается. */
  set(fileId: string, copy?: StoredImage): void {
    this.store.setAnnouncePhoto(fileId);
    this.removeFiles();
    if (copy) this.write(fileId, copy);
  }

  /** Картинка только в виде локального файла: Telegram получит её файлом, Discord — тоже. */
  setLocal(copy: StoredImage): void {
    const id = `${LOCAL_PREFIX}${randomUUID()}`;
    this.store.setAnnouncePhoto(id);
    this.removeFiles();
    this.write(id, copy);
  }

  /** file_id для Telegram; null — картинки нет или она только локальная. */
  telegramFileId(): string | null {
    const id = this.store.announcePhoto();
    return id && !id.startsWith(LOCAL_PREFIX) ? id : null;
  }

  /** Есть ли картинка, которую можно отправить: локальная копия или file_id при живом Telegram. */
  has(): boolean {
    if (!this.store.announcePhoto()) return false;
    return (this.telegram !== undefined && this.telegramFileId() !== null) || this.read() !== null;
  }

  clear(): void {
    this.store.clearAnnouncePhoto();
    this.removeFiles();
  }

  /** Копия на диске, если она соответствует текущему file_id. */
  read(): StoredImage | null {
    const fileId = this.store.announcePhoto();
    if (!fileId || !existsSync(this.metaPath) || !existsSync(this.dataPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(this.metaPath, 'utf8')) as Partial<Meta>;
      if (meta.fileId !== fileId || typeof meta.type !== 'string') return null;
      return { data: new Uint8Array(readFileSync(this.dataPath)), type: meta.type };
    } catch {
      return null;
    }
  }

  /**
   * Копия на диске, а если её нет — один раз скачивается из Telegram и сохраняется.
   * null — своей картинки нет или взять её неоткуда (нет копии и Telegram); ошибка скачивания пробрасывается.
   */
  async load(): Promise<StoredImage | null> {
    const fileId = this.store.announcePhoto();
    if (!fileId) return null;
    const stored = this.read();
    if (stored) return stored;
    if (!this.telegram || this.telegramFileId() === null) return null;
    const telegram = this.telegram;

    if (this.downloading?.fileId !== fileId) {
      const promise = this.download(telegram, fileId).finally(() => {
        if (this.downloading?.promise === promise) this.downloading = null;
      });
      this.downloading = { fileId, promise };
    }
    return this.downloading.promise;
  }

  private async download(telegram: FileDownloader, fileId: string): Promise<StoredImage> {
    const image = { data: await telegram.downloadFile(fileId), type: TELEGRAM_TYPE };
    // За время скачивания картинку могли заменить или сбросить: чужую копию не пишем.
    if (this.store.announcePhoto() === fileId) this.write(fileId, image);
    return image;
  }

  private write(fileId: string, image: StoredImage): void {
    mkdirSync(this.dir, { recursive: true });
    // Метаданные пишем последними: пока их нет, копия считается отсутствующей.
    writeFileSync(this.dataPath, image.data);
    writeFileSync(this.metaPath, JSON.stringify({ fileId, type: image.type } satisfies Meta));
  }

  private removeFiles(): void {
    rmSync(this.metaPath, { force: true });
    rmSync(this.dataPath, { force: true });
  }
}
