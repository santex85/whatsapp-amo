import makeWASocket, { WASocket, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import logger from '../utils/logger';
import { createAuthState } from './storage';
import { setupConnectionHandler } from './handlers/connection';
import { setupMessageHandler, IncomingMessage } from './handlers/messages';
import { getSyncHistoryEnabled } from '../database/sqlite';

export interface WhatsAppClientOptions {
  accountId: string;
  onQR?: (qr: string) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onMessage?: (message: IncomingMessage) => void;
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private accountId: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private callbacks: {
    onQR?: (qr: string) => void;
    onConnected?: () => void;
    onDisconnected?: (reason: string) => void;
    onMessage?: (message: IncomingMessage) => void;
  };

  constructor(options: WhatsAppClientOptions) {
    this.accountId = options.accountId;
    this.callbacks = {
      onQR: options.onQR,
      onConnected: options.onConnected,
      onDisconnected: options.onDisconnected,
      onMessage: options.onMessage,
    };
  }

  async connect(): Promise<void> {
    try {
      logger.info({ accountId: this.accountId }, '🔌 Подключение к WhatsApp...');

      const { state, saveCreds } = await createAuthState(this.accountId);
      const { version } = await fetchLatestBaileysVersion();

      // Создаем отдельный logger с уровнем warn для Baileys, чтобы уменьшить шум от Bad MAC ошибок
      // Эти ошибки нормальны для WhatsApp Signal Protocol и обрабатываются автоматически
      // Bad MAC возникает при попытке расшифровать сообщения с устаревшими/невалидными сессиями
      const baileysLogger = pino({
        level: 'warn', // Показываем только предупреждения и ошибки, игнорируем debug/info от libsignal
        // Не используем transport для этого logger, чтобы избежать дублирования
      });
      
      this.sock = makeWASocket({
        auth: state,
        version,
        // printQRInTerminal удален (deprecated), QR код получаем через событие connection.update
        logger: baileysLogger,
        browser: ['Desktop', 'Chrome', '10.0.0'],
        getMessage: async () => {
          // Для получения сообщений из истории (опционально)
          return undefined;
        },
        // Настройки для обработки сообщений
        markOnlineOnConnect: true,
        syncFullHistory: getSyncHistoryEnabled(), // Синхронизация истории (из БД или переменной окружения)
        generateHighQualityLinkPreview: false,
      });

      // Сохраняем credentials при обновлении
      this.sock.ev.on('creds.update', saveCreds);

      // Настраиваем обработчики
      setupConnectionHandler(this.sock, this.accountId, {
        onQR: (qr) => {
          if (this.callbacks.onQR) {
            this.callbacks.onQR(qr);
          }
        },
        onConnected: () => {
          this.reconnectAttempts = 0;
          if (this.callbacks.onConnected) {
            this.callbacks.onConnected();
          }
        },
        onDisconnected: (reason) => {
          if (this.callbacks.onDisconnected) {
            this.callbacks.onDisconnected(reason);
          }
          this.handleDisconnect();
        },
        onConnecting: () => {
          // Можно добавить логику
        },
      });

      setupMessageHandler(this.sock, this.accountId, {
        onMessage: (message) => {
        if (this.callbacks.onMessage) {
          this.callbacks.onMessage(message);
        } else {
          logger.warn({ accountId: this.accountId }, '⚠️ Callback onMessage не установлен');
        }
        },
      });

      logger.info({ accountId: this.accountId }, '✅ WhatsApp клиент инициализирован');
    } catch (err) {
      logger.error({ err, accountId: this.accountId }, 'Failed to connect to WhatsApp');
      throw err;
    }
  }

  private handleDisconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error({ accountId: this.accountId }, 'Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff

    logger.info(
      { accountId: this.accountId, attempt: this.reconnectAttempts, delay },
      'Scheduling reconnect'
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch((err) => {
        logger.error({ err, accountId: this.accountId }, 'Reconnect failed');
      });
    }, delay);
  }

  async sendMessage(to: string, message: string, options?: { mediaUrl?: string; mediaType?: string }): Promise<void> {
    if (!this.sock) {
      const error = new Error('WhatsApp client not connected');
      logger.error({ accountId: this.accountId, to, errorMessage: error.message }, '❌ Cannot send message: client not connected');
      throw error;
    }

    try {
      logger.info({ accountId: this.accountId, to, messageLength: message.length, messagePreview: message.substring(0, 50) }, '📤 Sending message via WhatsApp client');
      
      if (options?.mediaUrl && options?.mediaType) {
        // Отправка медиа будет обработана в media/uploader.ts
        throw new Error('Media sending not implemented in client, use media handler');
      } else {
        const result = await this.sock.sendMessage(to, { text: message });
        logger.info({ 
          accountId: this.accountId, 
          to, 
          messageLength: message.length,
          messageId: result?.key?.id,
          status: result?.status
        }, '✅ Message sent successfully via WhatsApp');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      const errorStack = err instanceof Error ? err.stack : undefined;
      logger.error({ 
        err, 
        accountId: this.accountId, 
        to,
        messageLength: message.length,
        errorMessage,
        errorStack
      }, '❌ Failed to send message via WhatsApp client');
      console.error(`[ERROR] WhatsApp sendMessage failed: ${errorMessage}`, err);
      throw err;
    }
  }

  async sendTyping(to: string, duration: number = 1500): Promise<void> {
    if (!this.sock) {
      return;
    }

    try {
      await this.sock.sendPresenceUpdate('composing', to);
      setTimeout(async () => {
        if (this.sock) {
          await this.sock.sendPresenceUpdate('paused', to);
        }
      }, duration);
    } catch (err) {
      logger.error({ err, accountId: this.accountId, to }, 'Failed to send typing indicator');
    }
  }

  isConnected(): boolean {
    return this.sock !== null;
  }

  getSocket(): WASocket | null {
    return this.sock;
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.sock) {
      await this.sock.end(undefined);
      this.sock = null;
      logger.info({ accountId: this.accountId }, 'WhatsApp client disconnected');
    }
  }
}

