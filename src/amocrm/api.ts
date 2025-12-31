import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { amocrmConfig } from '../config/amocrm';
import { AmoCRMOAuth } from './oauth';
import logger from '../utils/logger';
import { AmoCRMError } from '../utils/errors';
import { AmoCRMSendMessageRequest, AmoCRMChatMessage } from './types';
import { getAmoCRMTokens, saveConversationId, getConversationId } from '../database/sqlite';

export class AmoCRMAPI {
  private accountId: string;
  private oauth: AmoCRMOAuth;
  private axiosInstance: AxiosInstance;

  constructor(accountId: string, subdomain: string) {
    this.accountId = accountId;
    this.oauth = new AmoCRMOAuth(accountId, subdomain);
    this.axiosInstance = axios.create({
      baseURL: amocrmConfig.apiUrl(subdomain),
    });
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.oauth.getValidTokens();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  async sendMessage(chatId: string, content: string, options?: {
    uniq?: string;
    attachments?: Array<{ url: string; type: string }>;
  }): Promise<void> {
    // Проверяем, есть ли сохраненный scope_id в БД
    const tokens = getAmoCRMTokens(this.accountId);
    if (tokens?.scope_id) {
      return this.sendScopedMessage(chatId, content, options, tokens.scope_id);
    }

    // Fallback: проверяем статический scope_id из .env (для обратной совместимости)
    const staticScopeId = amocrmConfig.scopeId;
    if (staticScopeId) {
      return this.sendScopedMessage(chatId, content, options, staticScopeId);
    }

    // Для внешней интеграции пробуем несколько вариантов endpoints
    // Пробуем варианты по порядку до первого успешного
    const methods: Array<{ name: string; fn: () => Promise<void> }> = [
      { name: 'trySendViaApiV4', fn: () => this.trySendViaApiV4(chatId, content, options) },
      { name: 'trySendViaAmojoV2', fn: () => this.trySendViaAmojoV2(chatId, content, options) },
      { name: 'trySendViaAmojoV2Alternative', fn: () => this.trySendViaAmojoV2Alternative(chatId, content, options) },
    ];

    let lastError: any = null;
    for (const { name, fn } of methods) {
      try {
        await fn();
        return; // Успешно отправили
      } catch (err: any) {
        lastError = err;
        // Краткое логирование, детали только при debug
        logger.debug(
          { 
            accountId: this.accountId, 
            method: name,
            status: err.response?.status,
            error: err.response?.data?.detail || err.message,
          },
          'Метод не сработал, пробуем следующий'
        );
        // Продолжаем пробовать следующий метод
      }
    }

    // Все методы не сработали
    throw new AmoCRMError(
      lastError?.response?.data?.detail || lastError?.message || 'All send methods failed',
      'SEND_MESSAGE_ERROR',
      lastError?.response?.status || 500
    );
  }

  // Вариант 1: Стандартный API v4
  private async trySendViaApiV4(chatId: string, content: string, options?: {
    uniq?: string;
    attachments?: Array<{ url: string; type: string }>;
  }): Promise<void> {
    const headers = await this.getAuthHeaders();
    
    // Нормализуем chatId - убираем суффиксы для групповых чатов
    const normalizedChatId = chatId.split('-')[0].split('@')[0];
    
    const message: AmoCRMChatMessage = {
      content,
      uniq: options?.uniq || `wa_${Date.now()}`,
      created_at: Math.floor(Date.now() / 1000),
    };

    const payload: AmoCRMSendMessageRequest = {
      chat_id: normalizedChatId,
      message,
      source: {
        external_id: `whatsapp_${this.accountId}`,
      },
    };

    // Если есть вложения, добавляем их
    if (options?.attachments && options.attachments.length > 0) {
      message.content += '\n\nВложения:';
      options.attachments.forEach((att, index) => {
        message.content += `\n${index + 1}. ${att.url}`;
      });
    }

    // Детали только при debug уровне
    await this.axiosInstance.post(
      '/chats/messages',
      payload,
      { headers }
    );

    logger.info(
      { accountId: this.accountId, chatId: normalizedChatId },
      '✅ Сообщение отправлено в amoCRM'
    );
  }

  // Вариант 2: amojo API v2 (стандартный формат)
  private async trySendViaAmojoV2(chatId: string, content: string, options?: {
    uniq?: string;
    attachments?: Array<{ url: string; type: string }>;
  }): Promise<void> {
    const tokens = getAmoCRMTokens(this.accountId);
    if (!tokens) {
      throw new AmoCRMError('No tokens found', 'NO_TOKENS', 401);
    }

    const headers = await this.getAuthHeaders();
    
    // Нормализуем chatId
    const normalizedChatId = chatId.split('-')[0].split('@')[0];
    const phoneNumber = normalizedChatId.replace(/[^0-9]/g, '');
    
    // Формат для amojo v2
    const payload = {
      event_type: 'new_message',
      payload: {
        msgid: options?.uniq || `wa_${Date.now()}`,
        conversation_id: normalizedChatId,
        timestamp: Math.floor(Date.now() / 1000),
        sender: {
          id: normalizedChatId,
          name: `WhatsApp ${normalizedChatId}`,
          profile: {
            phone: phoneNumber,
          },
        },
        message: {
          type: 'text',
          text: content,
        },
      },
    };

    // Пробуем разные варианты URL
    // Для внешней интеграции нужен правильный идентификатор
    const clientId = amocrmConfig.clientId;
    const amojoAccountId = amocrmConfig.amojoAccountId;
    
    const baseUrls = [
      // Вариант с client_id (если есть)
      ...(clientId ? [`https://amojo.amocrm.ru/v2/origin/custom/${clientId}`] : []),
      // Вариант с subdomain
      `https://amojo.amocrm.ru/v2/origin/custom/${tokens.subdomain}`,
      // Вариант с amojo_account_id (если есть)
      ...(amojoAccountId ? [`https://amojo.amocrm.ru/v2/origin/custom/${amojoAccountId}`] : []),
    ];

    let lastError: any = null;
    for (const url of baseUrls) {
      try {
        // Детали только при debug
        await axios.post(url, payload, { headers });
        logger.info(
          { accountId: this.accountId, chatId: normalizedChatId },
          '✅ Сообщение отправлено в amoCRM'
        );
        return;
      } catch (err: any) {
        lastError = err;
        logger.debug({ 
          url, 
          status: err.response?.status,
          statusText: err.response?.statusText,
          error: err.response?.data 
        }, 'Failed to send via URL, trying next');
      }
    }

    throw lastError || new AmoCRMError('Failed to send via amojo v2', 'AMOJO_V2_ERROR', 500);
  }

  // Вариант 3: amojo API v2 (альтернативный формат с integration_id)
  private async trySendViaAmojoV2Alternative(chatId: string, content: string, _options?: {
    uniq?: string;
    attachments?: Array<{ url: string; type: string }>;
  }): Promise<void> {
    const tokens = getAmoCRMTokens(this.accountId);
    if (!tokens) {
      throw new AmoCRMError('No tokens found', 'NO_TOKENS', 401);
    }

    const headers = await this.getAuthHeaders();
    
    // Нормализуем chatId
    const normalizedChatId = chatId.split('-')[0].split('@')[0];
    const phoneNumber = normalizedChatId.replace(/[^0-9]/g, '');
    
    // Альтернативный формат - создание/отправка через chats endpoint
    const payload = {
      conversation_id: normalizedChatId,
      source: {
        external_id: `whatsapp_${this.accountId}`,
      },
      user: {
        id: normalizedChatId,
        name: `WhatsApp ${normalizedChatId}`,
        profile: {
          phone: phoneNumber,
        },
      },
      message: {
        type: 'text',
        text: content,
        timestamp: Math.floor(Date.now() / 1000),
      },
    };

    // Пробуем разные варианты URL с integration_id
    // Для внешней интеграции формат может быть разным
    const clientId = amocrmConfig.clientId;
    const amojoAccountId = amocrmConfig.amojoAccountId;

    const baseUrls = [
      // Формат: {client_id}_{amojo_account_id}/chats
      ...(clientId && amojoAccountId ? [
        `https://amojo.amocrm.ru/v2/origin/custom/${clientId}_${amojoAccountId}/chats`,
      ] : []),
      // Формат: {client_id}_{subdomain}/chats
      ...(clientId ? [
        `https://amojo.amocrm.ru/v2/origin/custom/${clientId}_${tokens.subdomain}/chats`,
      ] : []),
      // Формат: только {client_id}/chats
      ...(clientId ? [
        `https://amojo.amocrm.ru/v2/origin/custom/${clientId}/chats`,
      ] : []),
      // Формат: только {amojo_account_id}/chats
      ...(amojoAccountId ? [
        `https://amojo.amocrm.ru/v2/origin/custom/${amojoAccountId}/chats`,
      ] : []),
    ];

    if (baseUrls.length === 0) {
      throw new AmoCRMError(
        'AMOCRM_CLIENT_ID or AMOCRM_AMOJO_ACCOUNT_ID is required for external integration',
        'MISSING_CREDENTIALS',
        400
      );
    }

    let lastError: any = null;
    for (const url of baseUrls) {
      try {
        // Детали только при debug
        await axios.post(url, payload, { headers });
        logger.info(
          { accountId: this.accountId, chatId: normalizedChatId },
          '✅ Сообщение отправлено в amoCRM'
        );
        return;
      } catch (err: any) {
        lastError = err;
        logger.debug({ 
          url, 
          status: err.response?.status,
          statusText: err.response?.statusText,
          error: err.response?.data 
        }, 'Failed to send via URL, trying next');
      }
    }

    throw lastError || new AmoCRMError('Failed to send via amojo v2 alternative', 'AMOJO_V2_ALT_ERROR', 500);
  }

  async uploadFile(filePath: string, fileName: string, mimeType: string): Promise<string> {
    try {
      const headers = await this.getAuthHeaders();
      delete headers['Content-Type']; // axios установит multipart/form-data автоматически

      const FormData = require('form-data');
      const fs = require('fs');
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), {
        filename: fileName,
        contentType: mimeType,
      });

      const response = await this.axiosInstance.post(
        '/chats/files',
        form,
        {
          headers: {
            ...headers,
            ...form.getHeaders(),
          },
        }
      );

      logger.info({ accountId: this.accountId, fileId: response.data?.id }, 'File uploaded to amoCRM');
      
      // Возвращаем публичную ссылку на файл
      return response.data?.url || response.data?.download_url || '';
    } catch (err: any) {
      logger.error({ err, accountId: this.accountId }, 'Failed to upload file to amoCRM');
      throw new AmoCRMError(
        err.response?.data?.detail || 'Failed to upload file',
        'UPLOAD_FILE_ERROR',
        err.response?.status || 500
      );
    }
  }

  async getChannels(): Promise<any[]> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.axiosInstance.get('/chats/channels', { headers });
      return response.data?._embedded?.channels || [];
    } catch (err: any) {
      logger.error({ err, accountId: this.accountId }, 'Failed to get channels');
      throw new AmoCRMError(
        err.response?.data?.detail || 'Failed to get channels',
        'GET_CHANNELS_ERROR',
        err.response?.status || 500
      );
    }
  }

  /**
   * Формирует подпись запроса согласно документации amoCRM
   * Формат: HMAC-SHA1 от строки: METHOD\nContent-MD5\nContent-Type\nDate\nPath
   */
  private createSignature(
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
  private createSignedHeaders(
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

    const signature = this.createSignature(
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

  private async sendScopedMessage(chatId: string, content: string, options?: {
    uniq?: string;
    attachments?: Array<{ url: string; type: string }>;
  }, scopeId?: string): Promise<void> {
    // Согласно документации, scope_id может быть в формате {uuid1}_{uuid2}
    // Пример: 344a5002-f8ca-454d-af3d-396180102ac7_52e591f7-c98f-4255-8495-827210138c81
    // НЕ нормализуем scope_id - используем как есть из БД
    const finalScopeId = scopeId;
    
    // Проверяем и логируем scope_id перед отправкой запроса
    if (!finalScopeId) {
      logger.error(
        { accountId: this.accountId },
        '❌ ERROR: scope_id is not configured. Please run /api/amocrm/connect first to get scope_id'
      );
      throw new AmoCRMError(
        'scope_id is not configured. Please run /api/amocrm/connect first to get scope_id',
        'NO_SCOPE_ID',
        400
      );
    }
    
    // Логируем scope_id для отладки
    const scopeIdParts = finalScopeId.split('_');
    const scopeIdInfo = {
      accountId: this.accountId,
      scopeId: finalScopeId,
      scopeIdLength: finalScopeId.length,
      hasUnderscore: finalScopeId.includes('_'),
      partsCount: scopeIdParts.length,
      firstPart: scopeIdParts[0],
      secondPart: scopeIdParts[1] || null,
      firstPartLength: scopeIdParts[0]?.length || 0,
      secondPartLength: scopeIdParts[1]?.length || 0,
    };
    
    logger.info(scopeIdInfo, '🔍 DEBUG: scope_id проверен перед отправкой запроса');
    
    // Проверяем формат scope_id
    if (scopeIdParts.length > 2) {
      logger.warn(
        { accountId: this.accountId, scopeId: finalScopeId, partsCount: scopeIdParts.length },
        '⚠️ WARNING: scope_id содержит более 2 частей (необычный формат)'
      );
    }

    try {
      const { channelCode, channelSecret } = amocrmConfig;
      if (!channelCode || !channelSecret) {
        throw new AmoCRMError(
          'Channel Code and Secret are required for signed requests',
          'MISSING_CHANNEL_CREDENTIALS',
          400
        );
      }

      // Нормализуем chatId - убираем префиксы и нецифровые символы
      // chatId может быть в формате: "79261234567", "7926-1234-5678", "79261234567@s.whatsapp.net" и т.д.
      const normalizedChatId = chatId.split('-')[0].split('@')[0];
      // Извлекаем только цифры для единообразного хранения в БД
      const phoneNumber = normalizedChatId.replace(/[^0-9]/g, '');
      
      if (!phoneNumber || phoneNumber.length === 0) {
        throw new AmoCRMError(
          `Invalid phone number extracted from chatId: ${chatId}`,
          'INVALID_PHONE_NUMBER',
          400
        );
      }
      
      // Пытаемся получить сохраненный conversation_id из БД
      const savedConversationId = getConversationId(this.accountId, phoneNumber);
      // Используем сохраненный conversation_id, если есть, иначе используем номер телефона
      const conversationIdToUse = savedConversationId || normalizedChatId;
      
      if (savedConversationId) {
        logger.info(
          { 
            accountId: this.accountId, 
            phoneNumber,
            savedConversationId,
            conversationIdToUse,
          },
          '✅ Используется сохраненный conversation_id для существующего чата'
        );
      } else {
        logger.info(
          { 
            accountId: this.accountId, 
            phoneNumber,
            conversationIdToUse: normalizedChatId,
          },
          '🆕 Conversation_id не найден, будет создан новый чат'
        );
      }
      
      // #region agent log
      logger.debug(
        { 
          accountId: this.accountId, 
          originalChatId: chatId, 
          normalizedChatId,
          phoneNumber,
          savedConversationId,
          conversationIdToUse,
          scopeId: finalScopeId, 
          content: content.substring(0, 50),
          scopeIdLength: finalScopeId?.length,
          scopeIdFormat: finalScopeId?.includes('_') ? 'two_uuid' : 'single_uuid'
        },
        '🔍 DEBUG: sendScopedMessage started'
      );

      // Пробуем разные варианты payload и URL согласно документации amoCRM
      // Согласно ошибке от amoCRM "Request has invalid event type", нужен формат С event_type
      // Вариант 1: С event_type и payload wrapper (основной, согласно ошибке)
      // Вариант 2: Без wrapper, поля напрямую (альтернативный)
      // Вариант 3: С message на верхнем уровне
      const payloadVariants = [
        // Вариант 1: С event_type и payload (ПЕРВЫЙ - согласно ошибке amoCRM "Request has invalid event type")
        {
          event_type: 'new_message',
          payload: {
            msgid: options?.uniq || `wa_${Date.now()}`,
            conversation_id: conversationIdToUse,
            timestamp: Math.floor(Date.now() / 1000),
            sender: {
              id: conversationIdToUse,
              name: `WhatsApp ${normalizedChatId}`,
              profile: {
                phone: phoneNumber,
              },
            },
            message: {
              type: 'text',
              text: content,
            },
          },
        },
        // Вариант 2: Без event_type, поля напрямую (альтернативный)
        {
          conversation_id: conversationIdToUse,
          msgid: options?.uniq || `wa_${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000),
          sender: {
            id: conversationIdToUse,
            name: `WhatsApp ${normalizedChatId}`,
            profile: {
              phone: phoneNumber,
            },
          },
          message: {
            type: 'text',
            text: content,
          },
        },
        // Вариант 3: С message на верхнем уровне
        {
          message: {
            type: 'text',
            text: content,
            msgid: options?.uniq || `wa_${Date.now()}`,
          },
          conversation_id: conversationIdToUse,
          sender: {
            id: conversationIdToUse,
            name: `WhatsApp ${normalizedChatId}`,
            profile: {
              phone: phoneNumber,
            },
          },
        },
      ];
      
      // Правильный формат согласно документации: https://www.amocrm.ru/developers/content/chats/chat-step-by-step
      // Формат: /v2/origin/custom/{scope_id}
      // Пример: /v2/origin/custom/344a5002-f8ca-454d-af3d-396180102ac7_52e591f7-c98f-4255-8495-827210138c81
      // scope_id может быть в формате одного UUID или двух UUID через подчеркивание
      const pathVariants = [
        `/v2/origin/custom/${finalScopeId}`, // Основной формат согласно документации
      ];
      
      // Правильный домен согласно документации: https://www.amocrm.ru/developers/content/chats/chat-step-by-step
      const baseUrls = [
        'https://amojo.amocrm.ru', // Правильный домен согласно документации
      ];
      
      let lastError: any = null;
      
      // Определяем имена форматов payload по порядку (изменен порядок - with_event_type первый, согласно ошибке amoCRM)
      const payloadFormatNames = ['with_event_type', 'direct_fields', 'with_message_top'];
      
      // Пробуем все комбинации baseUrl, path и payload
      for (let baseUrlIndex = 0; baseUrlIndex < baseUrls.length; baseUrlIndex++) {
        const baseUrl = baseUrls[baseUrlIndex];
        for (let pathIndex = 0; pathIndex < pathVariants.length; pathIndex++) {
          const path = pathVariants[pathIndex];
          for (let payloadIndex = 0; payloadIndex < payloadVariants.length; payloadIndex++) {
            const payload = payloadVariants[payloadIndex];
            const payloadString = JSON.stringify(payload);
            const url = `${baseUrl}${path}`;
            const payloadFormatName = payloadFormatNames[payloadIndex];
          
          try {
            // Формируем заголовки с подписью согласно документации
            const signedHeaders = this.createSignedHeaders('POST', path, payloadString, channelSecret);
            
            // Добавляем OAuth токен в заголовки (может потребоваться для scoped endpoints)
            const authHeaders = await this.getAuthHeaders();
            const headers: Record<string, string> = {
              ...signedHeaders,
              'Authorization': authHeaders['Authorization'], // Добавляем только Authorization, Content-Type уже есть в signedHeaders
            };
            
            // Логируем на INFO уровне, чтобы видеть все попытки
            const requestInfo = {
              accountId: this.accountId, 
              url, 
              path,
              baseUrl,
              payloadFormat: payloadFormatName,
              scopeId: finalScopeId,
              channelCode,
              payload: JSON.stringify(payload).substring(0, 500),
              headers: Object.keys(headers),
              hasAuthorization: !!headers.Authorization,
              hasXSignature: !!headers['X-Signature'],
              attemptNumber: `${baseUrlIndex + 1}/${baseUrls.length} baseUrl, ${pathIndex + 1}/${pathVariants.length} path, ${payloadIndex + 1}/${payloadVariants.length} payload`
            };
            logger.info(requestInfo, `🔄 Попытка ${baseUrlIndex + 1}-${pathIndex + 1}-${payloadIndex + 1}: ${payloadFormatName} → ${baseUrl}${path}`);
            
            const response = await axios.post(url, payload, { headers });
            // #region agent log
            const responseDataStr = typeof response.data === 'string' ? response.data.substring(0, 1000) : JSON.stringify(response.data).substring(0, 1000);
            const responseIsHtml = typeof response.data === 'string' && response.data.trim().startsWith('<!DOCTYPE');
            const htmlTitle = responseIsHtml && typeof response.data === 'string' ? (response.data.match(/<title>(.*?)<\/title>/i)?.[1] || 'no title') : null;
            const htmlBody = responseIsHtml && typeof response.data === 'string' ? response.data.substring(0, 2000) : null;
            logger.info(
              { 
                accountId: this.accountId, 
                url, 
                status: response.status, 
                contentType: response.headers['content-type'], 
                isHtml: responseIsHtml, 
                htmlTitle, 
                htmlBody: htmlBody?.substring(0, 500), 
                responseData: responseDataStr, 
                payloadSent: JSON.stringify(payload).substring(0, 500),
                path,
                payloadFormat: payloadFormatName
              },
              '🔍 DEBUG: Response from amoCRM'
            );
          
          // Проверяем статус ответа
          // amoCRM может возвращать HTML с 200 статусом для успешных запросов
          if (response.status === 200) {
            // 200 OK - успешно, даже если это HTML
            // Продолжаем обработку успешного ответа
          } else if (response.status >= 400) {
            // Ошибка - пробуем следующий вариант
            lastError = new AmoCRMError(
              `amoCRM returned status ${response.status}`,
              'INVALID_RESPONSE',
              response.status
            );
            continue;
          }
          
          // Проверяем, что ответ - это JSON, а не HTML (только для логирования)
          const contentType = response.headers['content-type'] || '';
          const isHtml = typeof response.data === 'string' && response.data.trim().startsWith('<!DOCTYPE');
          
          if (isHtml && response.status === 200) {
            // HTML с 200 - это нормально для amoCRM, просто логируем
            logger.debug(
              { 
                accountId: this.accountId, 
                url, 
                contentType, 
                payloadFormat: payloadFormatName,
                path
              },
              `ℹ️ amoCRM вернул HTML с 200 статусом (это нормально)`
            );
          }
          
          // Успешно! Логируем успешную отправку с деталями
          const responseInfo: any = {
            accountId: this.accountId,
            chatId: normalizedChatId,
            conversationId: normalizedChatId,
            phoneNumber: normalizedChatId.replace(/[^0-9]/g, ''),
            status: response.status,
            url, // Логируем успешный URL
            payloadFormat: payloadFormatName,
          };
          
          // Сохраняем conversation_id из ответа, если есть
          let returnedConversationId: string | undefined;
          if (response.data && typeof response.data === 'object') {
            // Пробуем различные форматы ответа от amoCRM
            // Формат 1: { new_message: { conversation_id: "uuid", ... } }
            // Формат 2: { conversation_id: "uuid", ... }
            // Формат 3: { id: "uuid", ... } (может быть conversation_id)
            returnedConversationId = response.data.new_message?.conversation_id 
              || response.data.conversation_id 
              || response.data.id;
            
            // Используем phoneNumber который уже извлечен ранее (совпадает с тем, что используется для поиска)
            if (returnedConversationId && phoneNumber && phoneNumber.length > 0) {
              // Сохраняем conversation_id в БД для последующих сообщений
              saveConversationId(this.accountId, phoneNumber, returnedConversationId);
              logger.info(
                { 
                  accountId: this.accountId, 
                  phoneNumber, 
                  conversationId: returnedConversationId,
                  responseFormat: response.data.new_message?.conversation_id ? 'new_message.conversation_id' 
                    : response.data.conversation_id ? 'conversation_id' 
                    : response.data.id ? 'id' 
                    : 'unknown'
                },
                '💾 Conversation ID сохранен для последующих сообщений'
              );
            } else if (!returnedConversationId) {
              logger.debug(
                { 
                  accountId: this.accountId, 
                  phoneNumber,
                  responseData: response.data,
                  hasNewMessage: !!response.data.new_message,
                  hasConversationId: !!response.data.conversation_id,
                  hasId: !!response.data.id
                },
                '⚠️ Conversation ID не найден в ответе от amoCRM'
              );
            }
            
            if (response.data.lead_id) {
              responseInfo.leadId = response.data.lead_id;
              logger.info(
                { ...responseInfo },
                `✅ Сообщение отправлено в amoCRM. Создан лид: ${response.data.lead_id}`
              );
            } else if (response.data.id) {
              responseInfo.messageId = response.data.id;
              logger.info(
                { ...responseInfo },
                `✅ Сообщение отправлено в amoCRM. ID сообщения: ${response.data.id}`
              );
            } else {
              logger.info(
                { ...responseInfo, responseData: response.data },
                '✅ Сообщение отправлено в amoCRM'
              );
            }
          } else {
            logger.info(
              { ...responseInfo },
              '✅ Сообщение отправлено в amoCRM (статус: ' + response.status + ')'
            );
          }
          
          // Логируем ответ для отладки
          logger.debug(
            { 
              accountId: this.accountId,
              url,
              responseStatus: response.status,
              responseHeaders: response.headers,
              responseData: response.data
            },
            '📤 Ответ от amoCRM API'
          );
          
          return; // Успешно отправлено
        } catch (err: any) {
          lastError = err;
          // #region agent log
          logger.error(
            { 
              accountId: this.accountId, 
              url, 
              path,
              baseUrl,
              status: err.response?.status,
              statusText: err.response?.statusText,
              errorData: typeof err.response?.data === 'string' ? err.response.data.substring(0, 500) : err.response?.data,
              payloadFormat: payloadFormatName,
              scopeId: finalScopeId,
              channelCode,
              payload: JSON.stringify(payload).substring(0, 300),
            },
            `❌ ERROR: Request failed with status ${err.response?.status || 'unknown'}`
          );
          if (err.response?.status === 404) {
            // Логируем на INFO уровне, чтобы видеть все неудачные попытки
            logger.info(
              { 
                accountId: this.accountId, 
                url, 
                status: 404,
                payloadFormat: payloadFormatName,
                errorDetail: err.response?.data?.detail || err.response?.data?.title || err.message || 'Not Found',
                responseData: typeof err.response?.data === 'string' ? err.response.data.substring(0, 200) : err.response?.data
              },
              `❌ 404: ${payloadFormatName} → ${path}`
            );
            continue; // Пробуем следующий вариант payload/URL
          } else {
            // Другая ошибка - не пробуем дальше
            throw err;
          }
        }
      }
    }
      }
      
      // Все варианты не сработали
      if (lastError) {
        logger.error(
          { accountId: this.accountId, chatId: normalizedChatId, scopeId: finalScopeId, triedUrls: pathVariants },
          'Все варианты URL не сработали'
        );
        throw lastError;
      }
    } catch (err: any) {
      logger.error({ err, accountId: this.accountId, chatId, scopeId: finalScopeId }, 'Failed to send scoped message to amoCRM');

      if (err.response?.status === 401) {
        try {
          await this.oauth.refreshTokens();
          return this.sendScopedMessage(chatId, content, options, finalScopeId);
        } catch (refreshErr) {
          throw new AmoCRMError(
            'Failed to refresh tokens',
            'TOKEN_REFRESH_ERROR',
            401
          );
        }
      }

      throw new AmoCRMError(
        err.response?.data?.detail || err.message || 'Failed to send scoped message',
        'SEND_SCOPED_MESSAGE_ERROR',
        err.response?.status || 500
      );
    }
  }
}

