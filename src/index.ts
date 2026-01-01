// Загружаем .env в самом начале, до всех остальных импортов
import dotenv from 'dotenv';
dotenv.config();

// Перехватываем stderr для фильтрации безопасных ошибок от libsignal
// Bad MAC ошибки нормальны для Signal Protocol и обрабатываются автоматически
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const filteredErrors = [
  'Bad MAC',
  'Session error:Error: Bad MAC',
  'at Object.verifyMAC',
  'at SessionCipher.doDecryptWhisperMessage',
  'at async SessionCipher.decryptWithSessions',
  'at async _asyncQueueExecutor',
  'Closing open session in favor of incoming prekey bundle',
];

process.stderr.write = function(chunk: any, encoding?: any, callback?: any): boolean {
  if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
    const message = chunk.toString();
    // Фильтруем безопасные ошибки от libsignal
    if (filteredErrors.some(error => message.includes(error))) {
      // Подавляем эти ошибки, так как они нормальны для WhatsApp Signal Protocol
      return true;
    }
  }
  // Для всех остальных сообщений используем оригинальный stderr
  return originalStderrWrite(chunk, encoding, callback);
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
// Принудительный вывод для отладки - ВСЕГДА видимый
console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║  🚀 WhatsApp-amoCRM Gateway запускается...          ║');
console.log('╚══════════════════════════════════════════════════════╝\n');
process.stdout.write('[START] Приложение запускается (stdout)\n');
process.stderr.write('[START] Приложение запускается (stderr)\n');
console.log('[START] Приложение запускается (console.log)\n');

import { config } from './config';
import { amocrmConfig } from './config/amocrm';
import { getAmoCRMTokens } from './database/sqlite';
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
      console.log(`[DEBUG] ⏭️ Пропущено групповое сообщение от ${message.phoneNumber} (аккаунт: ${message.accountId})`);
      logger.info({ accountId: message.accountId, from: message.phoneNumber }, '⏭️ Пропущено групповое сообщение - не отправляется в amoCRM');
      return;
    }

    // Явный вывод для отладки - используем и stdout, и console.log
    process.stdout.write(`\n[DEBUG] 📥 Получено сообщение от ${message.phoneNumber} для аккаунта ${message.accountId}\n`);
    console.log(`[DEBUG] 📥 Получено сообщение от ${message.phoneNumber} для аккаунта ${message.accountId}`);
    logger.info({ accountId: message.accountId, from: message.phoneNumber, hasMedia: !!message.mediaType }, '📥 Обработка входящего сообщения');

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
    console.log(`[DEBUG] ⏭️ Пропущено групповое сообщение из очереди: ${data.from} (аккаунт: ${message.accountId})`);
    logger.info({ accountId: message.accountId, from: data.from }, '⏭️ Пропущено групповое сообщение из очереди - не отправляется в amoCRM');
    return;
  }
  
  // Явный вывод для отладки
  console.log(`[DEBUG] 🔄 Обработка сообщения из очереди: ${data.phoneNumber} (аккаунт: ${message.accountId}), текст: "${data.message?.substring(0, 50) || '(нет текста)'}", медиа: ${data.mediaType || 'нет'}`);
  logger.info({ 
    accountId: message.accountId, 
    phoneNumber: data.phoneNumber, 
    hasMessage: !!data.message,
    messagePreview: data.message?.substring(0, 100),
    hasMedia: !!data.mediaType,
    mediaType: data.mediaType
  }, '🔄 Обработка входящего сообщения из очереди');
  
  // Anti-ban: случайная задержка
  await randomDelay();

  // Получаем subdomain из сохраненных токенов или используем дефолтный
  const tokens = getAmoCRMTokens(message.accountId);
  const subdomain = tokens?.subdomain || amocrmConfig.subdomain || 'your_subdomain';
  
  if (!tokens) {
    console.log(`[DEBUG] ⚠️ Нет токенов amoCRM для аккаунта ${message.accountId}`);
    logger.warn({ accountId: message.accountId }, 'No amoCRM tokens found, skipping message');
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

    // Отправка в amoCRM
    // Если есть медиа, но нет текста, используем placeholder
    const messageText = data.message || (mediaUrl ? '📎 Медиафайл' : '');
    
    await amocrmAPI.sendMessage(
      data.phoneNumber, // chat_id в amoCRM
      messageText,
      {
        uniq: `wa_${data.timestamp}`,
        attachments: mediaUrl ? [{ url: mediaUrl, type: data.mediaType || 'unknown' }] : undefined,
      }
    );

    console.log(`[DEBUG] ✅ Сообщение отправлено в amoCRM: ${data.phoneNumber}, текст: "${messageText.substring(0, 50)}", медиа: ${mediaUrl ? 'да' : 'нет'}`);
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
    messagePreview: data.message?.substring(0, 50),
    queueMessageId: message.id
  }, '🔄 Начало обработки исходящего сообщения из очереди');
  console.log(`[DEBUG] 🔄 Обработка исходящего сообщения из очереди: account=${message.accountId}, to=${data.to}`);

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
  process.stdout.write(`\n[DEBUG] 📬 Manager получил событие message для аккаунта ${message.accountId}\n`);
  console.log(`[DEBUG] 📬 Manager получил событие message для аккаунта ${message.accountId}`);
  handleIncomingMessage(message).catch((err) => {
    process.stderr.write(`\n[DEBUG] ❌ Ошибка обработки сообщения: ${err}\n`);
    console.error(`[DEBUG] ❌ Ошибка обработки сообщения:`, err);
    logger.error({ err }, 'Error handling incoming message');
  });
});

// Добавляем логи для всех событий менеджера
manager.on('connected', ({ accountId }) => {
  console.log(`[DEBUG] ✅ Аккаунт ${accountId} подключен к WhatsApp`);
  logger.info({ accountId }, '✅ WhatsApp аккаунт подключен');
});

manager.on('disconnected', ({ accountId, reason }) => {
  console.log(`[DEBUG] ❌ Аккаунт ${accountId} отключен: ${reason}`);
  logger.warn({ accountId, reason }, '⚠️ WhatsApp аккаунт отключен');
});

manager.on('qr', ({ accountId }) => {
  console.log(`[DEBUG] 📱 QR код получен для аккаунта ${accountId}`);
  logger.info({ accountId }, '📱 QR код получен');
});

// Создание веб-сервера
const app = createWebServer(manager, handleOutgoingMessage);

// Запуск приложения
async function start() {
  try {
    // Принудительный вывод для отладки
    console.log('🚀 Запуск приложения...');
    process.stdout.write('[APP] Запуск приложения (stdout)\n');
    logger.info('🚀 Запуск приложения...');
    // Подключение к Redis
    console.log('📦 Подключение к Redis...');
    await queue.connect();
    console.log('✅ Подключен к Redis');
    logger.info('✅ Подключен к Redis');

    // Восстановление аккаунтов из сохраненных сессий
    console.log('🔄 Восстановление аккаунтов из сохраненных сессий...');
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
    console.log('🔄 Запуск обработчика очереди...');
    await queueProcessor.start();
    console.log('✅ Обработчик очереди запущен');
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

