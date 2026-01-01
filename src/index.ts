// Загружаем .env в самом начале, до всех остальных импортов
import dotenv from 'dotenv';
dotenv.config();

// Перехватываем stderr и stdout для фильтрации неважных сообщений
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

// Фильтры для подавления неважных сообщений
const filteredErrors = [
  'Bad MAC',
  'Session error:Error: Bad MAC',
  'at Object.verifyMAC',
  'at SessionCipher.doDecryptWhisperMessage',
  'at async SessionCipher.decryptWithSessions',
  'at async _asyncQueueExecutor',
  'at async 182909805834253',
  'Closing open session in favor of incoming prekey bundle',
  'MemoryStore is not designed for a production',
];

const filteredWarnings = [
  '[START] Приложение запускается',
];

// Перехватываем stderr
process.stderr.write = function(chunk: any, encoding?: any, callback?: any): boolean {
  if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
    const message = chunk.toString();
    // Фильтруем безопасные ошибки от libsignal и неважные предупреждения
    if (filteredErrors.some(error => message.includes(error)) || 
        filteredWarnings.some(warning => message.includes(warning))) {
      // Подавляем эти сообщения
      return true;
    }
  }
  // Для всех остальных сообщений используем оригинальный stderr
  return originalStderrWrite(chunk, encoding, callback);
};

// Перехватываем stdout для фильтрации неважных сообщений
process.stdout.write = function(chunk: any, encoding?: any, callback?: any): boolean {
  if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
    const message = chunk.toString();
    // Фильтруем отладочные сообщения
    if (filteredWarnings.some(warning => message.includes(warning)) ||
        message.includes('[DEBUG]') ||
        message.includes('[START] Приложение запускается')) {
      return true;
    }
  }
  return originalStdoutWrite(chunk, encoding, callback);
};

// Перехватываем console.error для фильтрации
const originalConsoleError = console.error.bind(console);
console.error = function(...args: any[]): void {
  const message = args.map(arg => String(arg)).join(' ');
  // Фильтруем Bad MAC ошибки и другие неважные сообщения
  if (!filteredErrors.some(error => message.includes(error))) {
    originalConsoleError(...args);
  }
};

import { initDatabase, initDefaultAdmin } from './database/sqlite';
import { WhatsAppManager } from './whatsapp/manager';
import { getQueue } from './queue/redis';
import { QueueProcessor } from './queue/processor';
import { QueueMessage, IncomingMessageData, OutgoingMessageData } from './queue/types';
import { AmoCRMAPI } from './amocrm/api';
import { AmoCRMWebhookPayload } from './amocrm/types';
import { createWebServer, startWebServer } from './web/server';
import { MediaStorage } from './media/storage';
import { MediaDownloader } from './media/downloader';
import { MediaUploader } from './media/uploader';
import { randomDelay } from './anti-ban/delay';
import { simulateTyping } from './anti-ban/typing';
import { messageRateLimiter } from './anti-ban/rate-limiter';
// Важное сообщение о запуске (через logger, чтобы подчинялось уровню логирования)

import { config } from './config';
import { amocrmConfig } from './config/amocrm';
import { getAmoCRMTokens, saveConversationId } from './database/sqlite';
import logger from './utils/logger';
import { IncomingMessage } from './whatsapp/handlers/messages';

// Инициализация компонентов
initDatabase();
// Инициализация первого администратора из .env (асинхронно, не блокирует запуск)
initDefaultAdmin().catch((err) => {
  logger.error({ 
    err, 
    errorMessage: err instanceof Error ? err.message : 'Unknown error',
    errorStack: err instanceof Error ? err.stack : undefined
  }, '❌ Failed to initialize default admin');
});
const queue = getQueue();
const manager = new WhatsAppManager();
const mediaStorage = new MediaStorage();
const mediaDownloader = new MediaDownloader(mediaStorage);
const mediaUploader = new MediaUploader(mediaStorage);
const queueProcessor = new QueueProcessor(queue);

// Обработчик входящих сообщений (WhatsApp → amoCRM)
async function handleIncomingMessage(message: IncomingMessage): Promise<void> {
  try {
    // Пропускаем групповые чаты - они не должны попадать в amoCRM
    if (message.isGroup) {
      logger.debug({ accountId: message.accountId, from: message.phoneNumber }, '⏭️ Пропущено групповое сообщение - не отправляется в amoCRM');
      return;
    }

    logger.info({ accountId: message.accountId, from: message.phoneNumber, hasMedia: !!message.mediaType }, '📥 Получено входящее сообщение');

    // Скачиваем медиафайлы сразу, если они есть
    let mediaFilePath: string | undefined;
    if (message.mediaType && message.originalMessage) {
      try {
        const client = manager.getAccount(message.accountId);
        if (client && client.getSocket()) {
          logger.info({ accountId: message.accountId, mediaType: message.mediaType }, '📥 Скачивание медиафайла из WhatsApp');
          const mediaResult = await mediaDownloader.downloadFromWhatsApp(
            client.getSocket()!,
            message
          );
          if (mediaResult) {
            mediaFilePath = mediaResult.filePath;
            logger.info({ accountId: message.accountId, filePath: mediaFilePath, fileName: mediaResult.fileName }, '✅ Медиафайл скачан');
          }
        }
      } catch (err) {
        logger.error({ err, accountId: message.accountId, mediaType: message.mediaType }, '❌ Ошибка скачивания медиафайла');
        // Продолжаем обработку сообщения даже если медиа не скачалось
      }
    }

    // Постановка в очередь
    const queueMessage: QueueMessage = {
      id: `incoming_${message.messageId}_${Date.now()}`,
      type: 'incoming',
      accountId: message.accountId,
      timestamp: Date.now(),
      data: {
        from: message.from,
        phoneNumber: message.phoneNumber,
        pushName: message.pushName,
        message: message.message,
        mediaType: message.mediaType,
        mediaUrl: mediaFilePath, // Сохраняем путь к скачанному файлу вместо 'pending'
        mediaMimetype: message.mediaMimetype,
        timestamp: message.timestamp,
      } as IncomingMessageData,
    };

    await queue.enqueue('incoming:queue', queueMessage);
  } catch (err) {
    logger.error({ err, accountId: message.accountId }, 'Failed to queue incoming message');
  }
}

// Обработчик исходящих сообщений (amoCRM → WhatsApp)
async function handleOutgoingMessage(payload: AmoCRMWebhookPayload): Promise<void> {
  try {
    logger.info({ 
      accountId: payload.account_id, 
      chatId: payload.chat_id,
      messageLength: payload.message.content?.length || 0,
      hasAttachments: !!payload.message.attachments?.length
    }, '📤 Обработка исходящего сообщения от amoCRM');

    // Проверяем, что WhatsApp аккаунт подключен
    const accountStatus = manager.getAccountStatus(payload.account_id);
    if (!accountStatus) {
      logger.error({ accountId: payload.account_id }, '❌ WhatsApp аккаунт не найден');
      throw new Error(`Account ${payload.account_id} not found. Please ensure WhatsApp account is connected.`);
    }

    if (!accountStatus.connected) {
      logger.error({ accountId: payload.account_id }, '❌ WhatsApp аккаунт не подключен');
      throw new Error(`Account ${payload.account_id} is not connected. Please scan QR code first.`);
    }

    // Извлекаем номер телефона из chat_id (формат может быть разным: "WhatsApp 182909805834253" или просто номер)
    let phoneNumber = payload.chat_id;
    
    // Убираем префикс "WhatsApp " если есть
    phoneNumber = phoneNumber.replace(/^WhatsApp\s+/i, '');
    
    // Убираем все нецифровые символы (оставляем только цифры)
    phoneNumber = phoneNumber.replace(/\D/g, '');
    
    if (!phoneNumber) {
      throw new Error(`Invalid chat_id format: ${payload.chat_id}. Cannot extract phone number.`);
    }
    
    // Сохраняем conversation_id из webhook payload, если он есть
    // Это важно для группировки сообщений в одну заявку в amoCRM
    if (payload.conversation_id && phoneNumber) {
      saveConversationId(payload.account_id, phoneNumber, payload.conversation_id);
      logger.info(
        { 
          accountId: payload.account_id, 
          phoneNumber, 
          conversationId: payload.conversation_id 
        },
        '💾 Conversation ID сохранен из webhook payload'
      );
    }
    
    // Формируем адрес WhatsApp
    const to = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

    logger.info({ 
      accountId: payload.account_id, 
      originalChatId: payload.chat_id,
      normalizedPhoneNumber: phoneNumber,
      whatsappAddress: to,
      messagePreview: payload.message.content?.substring(0, 50) || ''
    }, '📱 Подготовка к отправке сообщения в WhatsApp');

    // Постановка в очередь
    const queueMessage: QueueMessage = {
      id: `outgoing_${payload.account_id}_${Date.now()}`,
      type: 'outgoing',
      accountId: payload.account_id,
      timestamp: Date.now(),
      data: {
        to,
        message: payload.message.content,
        mediaUrl: payload.message.attachments?.[0]?.url,
        mediaType: payload.message.attachments?.[0]?.type,
      } as OutgoingMessageData,
    };

    await queue.enqueue('outgoing:queue', queueMessage);
    
    logger.info({ 
      accountId: payload.account_id, 
      to,
      queueMessageId: queueMessage.id
    }, '✅ Сообщение поставлено в очередь для отправки в WhatsApp');
  } catch (err) {
    logger.error({ 
      err, 
      accountId: payload.account_id,
      chatId: payload.chat_id,
      errorMessage: err instanceof Error ? err.message : 'Unknown error'
    }, '❌ Ошибка при постановке сообщения в очередь');
    throw err; // Пробрасываем ошибку, чтобы она была обработана в route handler
  }
}

// Регистрация обработчиков очереди
queueProcessor.registerProcessor('incoming', async (message: QueueMessage) => {
  const data = message.data as IncomingMessageData;
  
  // Дополнительная проверка: пропускаем групповые чаты (по адресу from, который содержит @g.us для групп)
  if (data.from?.endsWith('@g.us')) {
    logger.debug({ accountId: message.accountId, from: data.from }, '⏭️ Пропущено групповое сообщение из очереди - не отправляется в amoCRM');
    return;
  }
  
  logger.info({ 
    accountId: message.accountId, 
    phoneNumber: data.phoneNumber, 
    hasMessage: !!data.message,
    messagePreview: data.message?.substring(0, 100),
    hasMedia: !!data.mediaType
  }, '🔄 Обработка сообщения из очереди');
  
  // Anti-ban: случайная задержка
  await randomDelay();

  // Получаем subdomain из сохраненных токенов или используем дефолтный
  const tokens = getAmoCRMTokens(message.accountId);
  const subdomain = tokens?.subdomain || amocrmConfig.subdomain || 'your_subdomain';
  
  if (!tokens) {
    logger.warn({ accountId: message.accountId }, '⚠️ Нет токенов amoCRM для аккаунта, пропускаем сообщение');
    return;
  }

  const amocrmAPI = new AmoCRMAPI(message.accountId, subdomain);

  try {
    // Обработка медиафайлов (если есть)
    let mediaUrl: string | undefined;
    if (data.mediaType && data.mediaUrl && data.mediaUrl !== 'pending') {
      // data.mediaUrl содержит путь к скачанному файлу
      try {
        logger.info({ accountId: message.accountId, mediaType: data.mediaType, filePath: data.mediaUrl }, '📤 Загрузка медиафайла в amoCRM');
        mediaUrl = await mediaUploader.uploadToAmoCRM(
          amocrmAPI,
          data.mediaUrl,
          message.accountId
        );
        logger.info({ accountId: message.accountId, mediaUrl }, '✅ Медиафайл загружен в amoCRM');
      } catch (err) {
        logger.error({ err, accountId: message.accountId, mediaType: data.mediaType, filePath: data.mediaUrl }, '❌ Ошибка загрузки медиафайла в amoCRM');
        // Продолжаем отправку сообщения без медиа, если загрузка не удалась
      }
    }

    // Нормализуем phoneNumber: убираем все нецифровые символы для единообразия
    // Это важно для корректной работы с conversation_id
    const normalizedPhoneNumber = data.phoneNumber.replace(/[^0-9]/g, '');
    
    if (!normalizedPhoneNumber || normalizedPhoneNumber.length === 0) {
      logger.error({ accountId: message.accountId, originalPhoneNumber: data.phoneNumber }, '❌ Не удалось нормализовать номер телефона');
      throw new Error(`Invalid phone number: ${data.phoneNumber}`);
    }
    
    // Отправка в amoCRM
    // Если есть медиа, но нет текста, используем placeholder
    const messageText = data.message || (mediaUrl ? '📎 Медиафайл' : '');
    
    logger.debug(
      { 
        accountId: message.accountId, 
        originalPhoneNumber: data.phoneNumber, 
        normalizedPhoneNumber 
      }, 
      '📤 Отправка сообщения в amoCRM с нормализованным номером'
    );
    
    await amocrmAPI.sendMessage(
      normalizedPhoneNumber, // Используем нормализованный номер для поиска conversation_id
      messageText,
      {
        uniq: `wa_${data.timestamp}`,
        attachments: mediaUrl ? [{ url: mediaUrl, type: data.mediaType || 'unknown' }] : undefined,
      }
    );

    logger.info({ 
      accountId: message.accountId, 
      phoneNumber: data.phoneNumber, 
      hasMedia: !!mediaUrl,
      messageLength: messageText.length
    }, '✅ Сообщение отправлено в amoCRM');
  } catch (err) {
    logger.error({ err, accountId: message.accountId }, 'Failed to send message to amoCRM');
    throw err;
  }
});

queueProcessor.registerProcessor('outgoing', async (message: QueueMessage) => {
  const data = message.data as OutgoingMessageData;
  
  logger.info({ 
    accountId: message.accountId, 
    to: data.to,
    messagePreview: data.message?.substring(0, 50)
  }, '🔄 Обработка исходящего сообщения из очереди');

  // Anti-ban: проверка rate limit
  if (!(await messageRateLimiter.checkLimit(message.accountId))) {
    logger.warn({ accountId: message.accountId }, 'Rate limit exceeded, retrying later');
    await queue.retry(message);
    return;
  }

  // Anti-ban: симуляция печати
  await simulateTyping(manager, message.accountId, data.to);

  // Anti-ban: случайная задержка
  await randomDelay();

  try {
    // Обработка медиафайлов (если есть)
    if (data.mediaUrl && data.mediaType) {
      // Скачиваем файл из URL
      const fileName = `media_${Date.now()}.${data.mediaType.split('/')[1] || 'bin'}`;
      const filePath = await mediaDownloader.downloadFromUrl(
        data.mediaUrl,
        message.accountId,
        fileName
      );

      if (filePath) {
        const client = manager.getAccount(message.accountId);
        if (client && client.getSocket()) {
          await mediaUploader.sendToWhatsApp(
            client.getSocket()!,
            data.to,
            filePath,
            data.mediaType,
            data.message
          );
        }
      }
    } else {
      // Отправка текстового сообщения
      logger.info({ accountId: message.accountId, to: data.to, messagePreview: data.message?.substring(0, 50) }, '📤 Отправка текстового сообщения в WhatsApp');
      await manager.sendMessage(message.accountId, data.to, data.message);
    }

    logger.info({ accountId: message.accountId, to: data.to }, '✅ Сообщение успешно отправлено в WhatsApp');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const errorStack = err instanceof Error ? err.stack : undefined;
    logger.error({ 
      err, 
      accountId: message.accountId,
      to: data.to,
      messagePreview: data.message?.substring(0, 50),
      errorMessage,
      errorStack
    }, '❌ Ошибка отправки сообщения в WhatsApp');
    console.error(`[ERROR] Failed to send message to WhatsApp: ${errorMessage}`, err);
    throw err;
  }
});

// Подключение обработчиков WhatsApp
manager.on('message', (message: IncomingMessage) => {
  handleIncomingMessage(message).catch((err) => {
    logger.error({ err, accountId: message.accountId }, '❌ Ошибка обработки входящего сообщения');
  });
});

// Логирование важных событий
manager.on('connected', ({ accountId }) => {
  logger.info({ accountId }, '✅ WhatsApp аккаунт подключен');
});

manager.on('disconnected', ({ accountId, reason }) => {
  logger.warn({ accountId, reason }, '⚠️ WhatsApp аккаунт отключен');
});

manager.on('qr', ({ accountId }) => {
  logger.info({ accountId }, '📱 QR код получен');
});

// Создание веб-сервера
const app = createWebServer(manager, handleOutgoingMessage);

// Запуск приложения
async function start() {
  try {
    logger.info('🚀 Запуск приложения...');
    
    // Подключение к Redis
    logger.debug('📦 Подключение к Redis...');
    await queue.connect();
    logger.info('✅ Подключен к Redis');

    // Восстановление аккаунтов из сохраненных сессий
    logger.debug('🔄 Восстановление аккаунтов из сохраненных сессий...');
    try {
      const { promises: fsPromises } = await import('fs');
      const sessionsDir = './storage/sessions';
      const sessions = await fsPromises.readdir(sessionsDir, { withFileTypes: true });
      
      for (const session of sessions) {
        if (session.isDirectory() && session.name !== '{accountId}') {
          const accountId = session.name;
          logger.info({ accountId }, '🔄 Восстановление аккаунта из сессии');
          try {
            await manager.addAccount(accountId);
            logger.info({ accountId }, '✅ Аккаунт успешно восстановлен');
          } catch (err) {
            logger.error({ err, accountId }, '❌ Ошибка восстановления аккаунта');
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Не удалось восстановить аккаунты из сессий (возможно, директория не существует)');
    }

    // Запуск обработчика очереди
    logger.debug('🔄 Запуск обработчика очереди...');
    await queueProcessor.start();
    logger.info('✅ Обработчик очереди запущен');

    // Запуск веб-сервера
    await startWebServer(app);
    // Логирование уже есть в startWebServer

    // Периодическая очистка медиафайлов
    setInterval(() => {
      mediaStorage.cleanupOldFiles(config.media.cleanupInterval).catch((err) => {
        logger.error({ err }, 'Media cleanup error');
      });
    }, config.media.cleanupInterval);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down...');
      await queueProcessor.stop();
      await manager.disconnectAll();
      await queue.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Shutting down...');
      await queueProcessor.stop();
      await manager.disconnectAll();
      await queue.disconnect();
      process.exit(0);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start application');
    process.exit(1);
  }
}

start();

