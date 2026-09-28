import axios from 'axios';
import type { TwitchConfig } from '../config.js';
import { LiveStream, Platform } from '../types.js';
import { BaseWatcher, httpConfig } from './base.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const STREAMS_URL = 'https://api.twitch.tv/helix/streams';
/** Обновляем токен заранее, чтобы не попасть в момент истечения между проверками. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface StreamsResponse {
  data?: Array<{
    id: string;
    user_login: string;
    user_name: string;
    game_name?: string;
    type: string;
    title: string;
    viewer_count?: number;
    started_at: string;
    thumbnail_url?: string;
  }>;
}

export class TwitchWatcher extends BaseWatcher {
  readonly platform: Platform = 'twitch';

  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: TwitchConfig) {
    super();
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const response = await axios.post<TokenResponse>(TOKEN_URL, null, {
      ...httpConfig,
      params: {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'client_credentials',
      },
    });

    const { access_token: accessToken, expires_in: expiresIn } = response.data;
    if (!accessToken) {
      throw new Error('Twitch не вернул access_token — проверьте TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET');
    }

    this.token = accessToken;
    this.tokenExpiresAt = Date.now() + Math.max(0, (expiresIn ?? 3600) * 1000 - TOKEN_SAFETY_MARGIN_MS);
    return accessToken;
  }

  async fetchLive(): Promise<LiveStream | null> {
    let token = await this.accessToken();

    let response;
    try {
      response = await this.requestStreams(token);
    } catch (error) {
      // 401 бывает, если токен отозвали раньше срока: сбрасываем кэш и пробуем ещё раз.
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        this.token = null;
        token = await this.accessToken();
        response = await this.requestStreams(token);
      } else {
        throw error;
      }
    }

    const stream = response.data?.[0];
    if (!stream || stream.type !== 'live') return null;

    const startedAt = new Date(stream.started_at);
    return {
      platform: 'twitch',
      externalId: stream.id,
      title: stream.title,
      game: stream.game_name || undefined,
      url: `https://twitch.tv/${stream.user_login || this.config.login}`,
      thumbnailUrl: thumbnailUrl(stream.thumbnail_url, startedAt),
      startedAt,
      viewers: stream.viewer_count,
    };
  }

  private async requestStreams(token: string) {
    const response = await axios.get<StreamsResponse>(STREAMS_URL, {
      ...httpConfig,
      params: { user_login: this.config.login },
      headers: {
        ...httpConfig.headers,
        'Client-Id': this.config.clientId,
        Authorization: `Bearer ${token}`,
      },
    });
    return response.data;
  }
}

/**
 * Twitch отдаёт шаблон с плейсхолдерами размера. Плюс cache-buster: без него
 * Telegram покажет закэшированную картинку с прошлого стрима по тому же URL.
 */
export function thumbnailUrl(template: string | undefined, startedAt: Date): string | undefined {
  if (!template) return undefined;
  const sized = template.replace('{width}', '1280').replace('{height}', '720');
  const separator = sized.includes('?') ? '&' : '?';
  return `${sized}${separator}t=${startedAt.getTime()}`;
}
