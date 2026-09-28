import { LiveStream, Platform } from '../types.js';

export const REQUEST_TIMEOUT = 15_000;

/** Без браузерного User-Agent страница YouTube отдаёт урезанную разметку. */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const httpConfig = {
  timeout: REQUEST_TIMEOUT,
  headers: { 'User-Agent': USER_AGENT },
};

/**
 * Контракт вотчера: null — площадка точно офлайн, исключение — состояние
 * неизвестно (сеть, 5xx, смена разметки). Разница принципиальна: по ошибке
 * эфир закрывать нельзя, иначе переподключение породит второй анонс.
 */
export abstract class BaseWatcher {
  abstract readonly platform: Platform;

  abstract fetchLive(): Promise<LiveStream | null>;
}
