import { initDatabase } from './database/sqlite';
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
const queue = getQueue();
const manager = new WhatsAppManager();
const mediaStorage = new MediaStorage();
const mediaDownloader = new MediaDownloader(mediaStorage);
const mediaUploader = new MediaUploader(mediaStorage);
const queueProcessor = new QueueProcessor(queue);

// Обработчик входящих сообщений (WhatsApp → amoCRM)
async function handleIncomingMessage(message: IncomingMessage): Promise<void> {
  try {
    // Явный вывод для отладки - используем и stdout, и console.log
    process.stdout.write(`\n[DEBUG] 📥 Получено сообщение от ${message.phoneNumber} для аккаунта ${message.accountId}\n`);
    console.log(`[DEBUG] 📥 Получено сообщение от ${message.phoneNumber} для аккаунта ${message.accountId}`);
    logger.info({ accountId: message.accountId, from: message.phoneNumber }, '📥 Обработка входящего сообщения');

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
        mediaUrl: message.mediaUrl,
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
    logger.info({ accountId: payload.account_id, chatId: payload.chat_id }, '📤 Обработка исходящего сообщения');

    // Извлекаем номер телефона из chat_id (формат может быть разным)
    const phoneNumber = payload.chat_id;
    const to = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

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
  } catch (err) {
    logger.error({ err }, 'Failed to queue outgoing message');
  }
}

// Регистрация обработчиков очереди
queueProcessor.registerProcessor('incoming', async (message: QueueMessage) => {
  const data = message.data as IncomingMessageData;
  
  // Явный вывод для отладки
  console.log(`[DEBUG] 🔄 Обработка сообщения из очереди: ${data.phoneNumber} (аккаунт: ${message.accountId})`);
  
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
    if (data.mediaType) {
      logger.info({ accountId: message.accountId, mediaType: data.mediaType }, 'Processing media file');
      
      // Для полной обработки медиа нужно:
      // 1. В обработчике сообщений сохранять оригинальное сообщение
      // 2. Скачивать медиа сразу при получении сообщения
      // 3. Сохранять путь к файлу в очереди
      // 4. Загружать в amoCRM и получать публичную ссылку
      // Здесь упрощенная версия - медиа будет обработано позже
    }

    // Отправка в amoCRM
    await amocrmAPI.sendMessage(
      data.phoneNumber, // chat_id в amoCRM
      data.message || '',
      {
        uniq: `wa_${data.timestamp}`,
        attachments: mediaUrl ? [{ url: mediaUrl, type: data.mediaType || 'unknown' }] : undefined,
      }
    );

    console.log(`[DEBUG] ✅ Сообщение отправлено в amoCRM: ${data.phoneNumber}`);
    logger.info({ accountId: message.accountId, phoneNumber: data.phoneNumber }, '✅ Сообщение отправлено в amoCRM');
  } catch (err) {
    logger.error({ err, accountId: message.accountId }, 'Failed to send message to amoCRM');
    throw err;
  }
});

queueProcessor.registerProcessor('outgoing', async (message: QueueMessage) => {
  const data = message.data as OutgoingMessageData;

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
      await manager.sendMessage(message.accountId, data.to, data.message);
    }

    logger.info({ accountId: message.accountId, to: data.to }, 'Message sent to WhatsApp');
  } catch (err) {
    logger.error({ err, accountId: message.accountId }, 'Failed to send message to WhatsApp');
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

