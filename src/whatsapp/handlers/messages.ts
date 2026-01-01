import { 
  WASocket, 
  proto, 
  WAMessageContent,
  getContentType
} from '@whiskeysockets/baileys';
import logger from '../../utils/logger';

export interface IncomingMessage {
  accountId: string;
  messageId: string;
  from: string;
  phoneNumber: string;
  pushName: string | null;
  message: string | null;
  timestamp: number;
  mediaType?: string;
  mediaUrl?: string;
  mediaMimetype?: string;
  isGroup: boolean;
  isStatus: boolean;
  originalMessage?: proto.IWebMessageInfo; // Для скачивания медиа
}

export interface MessageHandlerCallbacks {
  onMessage: (message: IncomingMessage) => void;
}

export function setupMessageHandler(
  sock: WASocket,
  accountId: string,
  callbacks: MessageHandlerCallbacks
) {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Используем process.stdout.write для гарантированного вывода
    process.stdout.write(`\n[DEBUG] 📬 messages.upsert событие: type=${type}, messages=${messages.length}\n`);
    console.log(`[DEBUG] 📬 messages.upsert событие: type=${type}, messages=${messages.length}`);
    
    // Обрабатываем все типы, не только notify
    // notify - новые сообщения
    // append - сообщения из истории
    if (type === 'notify' || type === 'append') {
      console.log(`[DEBUG] ✅ Тип ${type} - обрабатываем ${messages.length} сообщений`);
      
      // Для сообщений из истории (append) пропускаем старые сообщения (старше 1 часа)
      // чтобы не дублировать их в amoCRM
      const historySyncThreshold = 60 * 60 * 1000; // 1 час
      const now = Date.now();
      
      for (const msg of messages) {
        try {
          // Проверяем время сообщения для истории
          if (type === 'append') {
            const messageTimestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : 0;
            const messageAge = now - messageTimestamp;
            if (messageAge > historySyncThreshold) {
              console.log(`[DEBUG] ⏭️ Пропущено: старое сообщение из истории (возраст: ${Math.round(messageAge / 1000 / 60)} минут)`);
              continue;
            }
          }
          
          console.log(`[DEBUG] 🔍 Обработка сообщения: from=${msg.key.remoteJid}, fromMe=${msg.key.fromMe}`);
          
          // Пропускаем сообщения, которые мы сами отправили (fromMe === true)
          if (msg.key.fromMe) {
            console.log(`[DEBUG] ⏭️ Пропущено: собственное отправленное сообщение (fromMe=true)`);
            continue;
          }
          
          // Пропускаем сообщения из групп (если нужно обрабатывать только личные)
          const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;
          
          // Пропускаем статусы
          const isStatus = msg.key.remoteJid === 'status@broadcast';
          if (isStatus) {
            console.log(`[DEBUG] ⏭️ Пропущено: статусное сообщение`);
            continue;
          }

          // Пропускаем сообщения о наборе текста и других статусных событиях
          const messageContent = msg.message;
          if (!messageContent) {
            console.log(`[DEBUG] ⏭️ Пропущено: нет содержимого сообщения`);
            continue;
          }

          // Проверяем, не является ли это служебным сообщением
          const messageType = getContentType(messageContent);
          console.log(`[DEBUG] 📋 Тип сообщения: ${messageType}`);
          if (messageType === 'protocolMessage' || messageType === 'senderKeyDistributionMessage') {
            console.log(`[DEBUG] ⏭️ Пропущено: служебное сообщение (${messageType})`);
            continue;
          }

          const from = msg.key.remoteJid || '';
          // Нормализуем phoneNumber: убираем все нецифровые символы для единообразия
          const phoneNumber = from.split('@')[0].replace(/[^0-9]/g, '');
          const pushName = msg.pushName || null;

          // Обрабатываем медиафайлы
          let mediaType: string | undefined;
          let mediaUrl: string | undefined;
          let mediaMimetype: string | undefined;
          let mediaCaption: string | undefined;

          if (messageType && ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
            mediaType = messageType;
            const mediaMessage = messageContent[messageType as keyof WAMessageContent] as any;
            mediaMimetype = mediaMessage?.mimetype;
            // Извлекаем подпись (caption) из медиафайла, если есть
            mediaCaption = mediaMessage?.caption || undefined;

            try {
              // Сохраняем информацию о медиа - фактическое скачивание будет в media/downloader.ts
              // Здесь только отмечаем, что есть медиа
              mediaUrl = 'pending'; // Будет обработано в media handler
            } catch (err) {
              logger.error({ err, accountId, messageId: msg.key.id }, 'Failed to process media');
            }
          }

          // Извлекаем текст сообщения
          let messageText: string | null = null;
          if (messageContent.conversation) {
            messageText = messageContent.conversation;
          } else if (messageContent.extendedTextMessage?.text) {
            messageText = messageContent.extendedTextMessage.text;
          } else if (mediaCaption) {
            // Если есть медиа с подписью, используем подпись как текст сообщения
            messageText = mediaCaption;
          }

          const incomingMessage: IncomingMessage = {
            accountId,
            messageId: msg.key.id || '',
            from,
            phoneNumber,
            pushName,
            message: messageText,
            timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
            mediaType,
            mediaUrl,
            mediaMimetype,
            isGroup,
            isStatus: false,
            originalMessage: msg, // Сохраняем оригинальное сообщение для медиа
          };

          // Явный вывод для отладки
          console.log(`[DEBUG] 📨 Входящее сообщение от ${phoneNumber} (аккаунт: ${accountId}), текст: "${messageText?.substring(0, 50)}..."`);
          
          logger.info(
            { 
              accountId, 
              from: phoneNumber, 
              hasMedia: !!mediaType,
              isGroup,
              messageType,
              messageText: messageText?.substring(0, 100)
            },
            '📨 Входящее сообщение'
          );

          console.log(`[DEBUG] 📤 Вызываем callback onMessage для аккаунта ${accountId}`);
          callbacks.onMessage(incomingMessage);
          console.log(`[DEBUG] ✅ Callback onMessage выполнен`);
        } catch (err) {
          console.error(`[DEBUG] ❌ Ошибка обработки сообщения:`, err);
          logger.error({ err, accountId, messageId: msg.key.id }, 'Error processing message');
        }
      }
    } else {
      console.log(`[DEBUG] ⏭️ Пропущено: тип события ${type} (не notify)`);
    }
  });

  // Обработка статусов отправки сообщений
  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      if (update.update?.status) {
        const status = update.update.status;
        const messageId = update.key?.id;
        
        // Логируем статусы доставки для диагностики
        const statusString = String(status);
        if (statusString.includes('ERROR') || statusString.includes('FAILED') || status === 3 || status === 4) {
          logger.error(
            { 
              accountId, 
              messageId,
              status,
              from: update.key?.remoteJid
            },
            '❌ Сообщение не доставлено (статус ERROR/FAILED)'
          );
        } else {
          logger.info(
            { 
              accountId, 
              messageId,
              status,
              from: update.key?.remoteJid
            },
            `📬 Статус сообщения: ${status}`
          );
        }
      }
    }
  });

  // Обработка ошибок дешифрования - логируем, но не обрабатываем
  // Эти ошибки означают, что сообщения не могут быть расшифрованы
  // и не попадут в messages.upsert
  sock.ev.on('creds.update', () => {
    logger.debug({ accountId }, 'Credentials updated - возможно, нужно переподключение');
  });
}

