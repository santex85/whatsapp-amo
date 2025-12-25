import axios from 'axios';
import { amocrmConfig } from '../config/amocrm';
import { saveAmoCRMTokens, getAmoCRMTokens, AmoCRMTokens } from '../database/sqlite';
import logger from '../utils/logger';
import { AmoCRMError } from '../utils/errors';
import { AmoCRMAuthResponse } from './types';

export class AmoCRMOAuth {
  private accountId: string;
  private subdomain: string;

  constructor(accountId: string, subdomain: string) {
    this.accountId = accountId;
    this.subdomain = subdomain;
  }

  getAuthorizationUrl(): string {
    const params = new URLSearchParams({
      client_id: amocrmConfig.clientId,
      redirect_uri: amocrmConfig.redirectUri,
      response_type: 'code',
      state: `${this.accountId}:${this.subdomain}`,
    });

    return `${amocrmConfig.authorizeUrl()}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string): Promise<AmoCRMTokens> {
    try {
      const response = await axios.post<AmoCRMAuthResponse>(
        amocrmConfig.oauthUrl(this.subdomain),
        {
          client_id: amocrmConfig.clientId,
          client_secret: amocrmConfig.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: amocrmConfig.redirectUri,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const tokens: AmoCRMTokens = {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_at: Date.now() + (response.data.expires_in * 1000),
        subdomain: this.subdomain,
      };

      saveAmoCRMTokens(this.accountId, tokens);
      logger.info({ accountId: this.accountId }, 'Tokens obtained successfully');

      return tokens;
    } catch (err: any) {
      logger.error({ err, accountId: this.accountId }, 'Failed to exchange code for tokens');
      throw new AmoCRMError(
        err.response?.data?.detail || 'Failed to exchange code for tokens',
        'TOKEN_EXCHANGE_ERROR',
        err.response?.status || 500
      );
    }
  }

  async refreshTokens(): Promise<AmoCRMTokens> {
    const currentTokens = getAmoCRMTokens(this.accountId);
    if (!currentTokens) {
      throw new AmoCRMError('No tokens found', 'NO_TOKENS', 401);
    }

    try {
      const response = await axios.post<AmoCRMAuthResponse>(
        amocrmConfig.oauthUrl(this.subdomain),
        {
          client_id: amocrmConfig.clientId,
          client_secret: amocrmConfig.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: currentTokens.refresh_token,
          redirect_uri: amocrmConfig.redirectUri,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const tokens: AmoCRMTokens = {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_at: Date.now() + (response.data.expires_in * 1000),
        subdomain: this.subdomain,
      };

      saveAmoCRMTokens(this.accountId, tokens);
      logger.info({ accountId: this.accountId }, 'Tokens refreshed successfully');

      return tokens;
    } catch (err: any) {
      logger.error({ err, accountId: this.accountId }, 'Failed to refresh tokens');
      throw new AmoCRMError(
        err.response?.data?.detail || 'Failed to refresh tokens',
        'TOKEN_REFRESH_ERROR',
        err.response?.status || 500
      );
    }
  }

  async getValidTokens(): Promise<string> {
    let tokens = getAmoCRMTokens(this.accountId);
    
    if (!tokens) {
      throw new AmoCRMError('No tokens found. Please authorize first.', 'NO_TOKENS', 401);
    }

    // Проверяем, не истекли ли токены (обновляем за 5 минут до истечения)
    if (tokens.expires_at - Date.now() < 5 * 60 * 1000) {
      logger.info({ accountId: this.accountId }, 'Tokens expired, refreshing...');
      tokens = await this.refreshTokens();
    }

    return tokens.access_token;
  }
}

