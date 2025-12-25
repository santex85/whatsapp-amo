import axios from 'axios';
import crypto from 'crypto';
import { amocrmConfig } from '../config/amocrm';
import logger from '../utils/logger';
import { AmoCRMError } from '../utils/errors';

export interface ConnectResponse {
  account_id: string;
  scope_id: string;
  title: string;
  hook_api_version?: string;
}

/**
 * Формирует подпись запроса согласно документации amoCRM
 * Формат: HMAC-SHA1 от строки: METHOD\nContent-MD5\nContent-Type\nDate\nPath
 */
function createSignature(
  method: string,
  contentMd5: string,
  contentType: string,
  date: string,
  path: string,
  secretKey: string
): string {
  const stringToSign = [
    method.toUpperCase(),
    contentMd5,
    contentType,
    date,
    path,
  ].join('\n');

  const signature = crypto
    .createHmac('sha1', secretKey)
    .update(stringToSign)
    .digest('hex')
    .toLowerCase();

  return signature;
}

/**
 * Формирует заголовки для запросов к API Чатов с подписью
 */
function createSignedHeaders(
  method: string,
  path: string,
  body: string,
  secretKey: string
): Record<string, string> {
  const date = new Date().toUTCString();
  const contentType = 'application/json';
  const contentMd5 = crypto
    .createHash('md5')
    .update(body)
    .digest('hex')
    .toLowerCase();

  const signature = createSignature(
    method,
    contentMd5,
    contentType,
    date,
    path,
    secretKey
  );

  return {
    'Date': date,
    'Content-Type': contentType,
    'Content-MD5': contentMd5,
    'X-Signature': signature,
  };
}

export async function connectChannel(
  accountId: string,
  _subdomain: string,
  amojoAccountId: string,
  channelTitle: string = 'WhatsApp Gateway'
): Promise<ConnectResponse> {
  const { channelCode, channelSecret } = amocrmConfig;

  // Используем channelCode (origin_code) вместо channelId
  if (!channelCode || !channelSecret) {
    throw new AmoCRMError(
      'Channel Code (origin_code) and Channel Secret are required. Set AMOCRM_CHANNEL_CODE and AMOCRM_CHANNEL_SECRET in .env',
      'MISSING_CHANNEL_CREDENTIALS',
      400
    );
  }

  if (!amojoAccountId) {
    throw new AmoCRMError(
      'amojo_account_id is required. Get it from browser console: AMOCRM.constant("account").amojo_id',
      'MISSING_AMOJO_ACCOUNT_ID',
      400
    );
  }

  // Пробуем разные варианты payload и URL
  const payloadVariants = [
    {
      account_id: amojoAccountId,
      title: channelTitle,
      hook_api_version: 'v2',
    },
    // Альтернативный вариант без hook_api_version
    {
      account_id: amojoAccountId,
      title: channelTitle,
    },
  ];

  const pathVariants = [
    `/v2/origin/custom/${channelCode}/connect`,
    // Альтернативный вариант с channelId вместо channelCode
    ...(amocrmConfig.channelId ? [`/v2/origin/custom/${amocrmConfig.channelId}/connect`] : []),
  ];

  let lastError: any = null;
  
  for (const path of pathVariants) {
    for (const payload of payloadVariants) {
      const payloadString = JSON.stringify(payload);
      const url = `https://amojo.amocrm.ru${path}`;

      try {
        // Формируем заголовки с подписью согласно документации
        const headers = createSignedHeaders('POST', path, payloadString, channelSecret);

        logger.info(
          { accountId, url },
          'Подключение к amoCRM каналу...'
        );

        const response = await axios.post<ConnectResponse>(
          url,
          payload,
          { headers }
        );

        logger.info(
          { accountId, scopeId: response.data.scope_id },
          '✅ Канал подключен успешно'
        );

        return response.data;
      } catch (err: any) {
        lastError = err;
        // Логируем только краткую информацию, детали только при debug
        logger.debug({ 
          accountId, 
          url,
          status: err.response?.status,
          error: err.response?.data?.detail || err.message,
        }, 'Попытка не удалась, пробуем следующий вариант');
        // Продолжаем пробовать следующий вариант
      }
    }
  }

  // Все варианты не сработали
  const errorMsg = lastError?.response?.data?.detail || lastError?.response?.data?.title || lastError?.message || 'Неизвестная ошибка';
  logger.error({ 
    accountId, 
    status: lastError?.response?.status,
    error: errorMsg,
  }, `❌ Не удалось подключить канал: ${errorMsg}`);
  
  throw new AmoCRMError(
    lastError?.response?.data?.detail || lastError?.response?.data?.title || lastError?.message || 'Failed to connect channel',
    'CONNECT_CHANNEL_ERROR',
    lastError?.response?.status || 500
  );
}
