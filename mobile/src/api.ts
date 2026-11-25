import type { InfoResponse } from '../../shared/api-v1';

export interface ConnectionCredentials {
  apiUrl: string;
  token: string;
}

export type ApiFailure = 'address' | 'authorization' | 'forbidden' | 'rate-limit' | 'http' | 'response' | 'incompatible' | 'unavailable' | 'cancelled';

export class ApiError extends Error {
  constructor(readonly kind: ApiFailure, readonly status?: number, readonly retryAt?: number) {
    super('Не удалось проверить подключение к боту.');
    this.name = 'ApiError';
  }
}

export function apiAddress(value: string): string {
  try {
    const url = new URL(value);
    if (value.trim() !== value || /[?#\s]/.test(value) || !['https:', 'http:'].includes(url.protocol) ||
        url.username || url.password || url.pathname !== '/api/v1') throw new Error();
    return url.href;
  } catch {
    throw new ApiError('address');
  }
}

export function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function retryTime(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : undefined;
  const time = seconds === undefined ? Date.parse(value) : Date.now() + seconds * 1000;
  return Number.isFinite(time) && time > Date.now() && time <= 8.64e15 ? time : undefined;
}

export function createApiClient(credentials: ConnectionCredentials, timeoutMs = 10000) {
  const apiUrl = apiAddress(credentials.apiUrl);
  if (!validToken(credentials.token)) throw new ApiError('authorization');
  const token = credentials.token;

  return {
    async checkConnection(signal?: AbortSignal): Promise<InfoResponse> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel: () => void = () => {};
      const interrupted = new Promise<never>((_resolve, reject) => {
        cancel = () => {
          reject(new ApiError('cancelled'));
          controller.abort();
        };
        signal?.addEventListener('abort', cancel);
        if (signal?.aborted) cancel();
        timer = setTimeout(() => {
          reject(new ApiError('unavailable'));
          controller.abort();
        }, timeoutMs);
      });

      try {
        const request = async (): Promise<InfoResponse> => {
          if (signal?.aborted) throw new ApiError('cancelled');
          const response = await fetch(`${apiUrl}/info`, {
            method: 'GET',
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
            signal: controller.signal,
            redirect: 'error',
          });
          if (!response.ok) {
            const kind = response.status === 401 ? 'authorization' : response.status === 403 ? 'forbidden' :
              response.status === 429 ? 'rate-limit' : 'http';
            throw new ApiError(kind, response.status, retryTime(response.headers.get('Retry-After')));
          }
          let data: unknown;
          try {
            data = await response.json();
          } catch {
            throw new ApiError('response');
          }
          if (!data || typeof data !== 'object' || !('apiVersion' in data) ||
              !Number.isInteger(data.apiVersion) || (data.apiVersion as number) < 1 ||
              !('version' in data) || typeof data.version !== 'string') throw new ApiError('response');
          if (data.apiVersion !== 1) throw new ApiError('incompatible');
          return { apiVersion: 1, version: data.version };
        };
        return await Promise.race([request(), interrupted]);
      } catch (error) {
        throw error instanceof ApiError ? error : new ApiError('unavailable');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}
