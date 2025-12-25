import { WASocket, downloadMediaMessage } from '@whiskeysockets/baileys';
import { MediaStorage } from './storage';
import logger from '../utils/logger';
import { IncomingMessage } from '../whatsapp/handlers/messages';

export class MediaDownloader {
  private storage: MediaStorage;

  constructor(storage: MediaStorage) {
    this.storage = storage;
  }

  async downloadFromWhatsApp(
    _sock: WASocket,
    message: IncomingMessage
  ): Promise<{ filePath: string; fileName: string; mimeType: string } | null> {
    if (!message.mediaType || !message.originalMessage) {
      return null;
    }

    try {
      logger.info({ accountId: message.accountId, mediaType: message.mediaType }, 'Downloading media from WhatsApp');

      const buffer = await downloadMediaMessage(
        message.originalMessage!,
        message.mediaType as any,
        {},
        { 
          logger: logger.child({ accountId: message.accountId }),
          reuploadRequest: async (msg) => msg
        }
      );

      if (!Buffer.isBuffer(buffer)) {
        throw new Error('Downloaded media is not a buffer');
      }

      // Генерируем имя файла
      const ext = this.getExtensionFromMimeType(message.mediaMimetype || '');
      const fileName = `media_${message.messageId}_${Date.now()}${ext}`;

      const filePath = await this.storage.saveFile(buffer, fileName, message.accountId);

      logger.info({ accountId: message.accountId, filePath }, 'Media downloaded successfully');

      return {
        filePath,
        fileName,
        mimeType: message.mediaMimetype || 'application/octet-stream',
      };
    } catch (err) {
      logger.error({ err, accountId: message.accountId }, 'Failed to download media');
      return null;
    }
  }

  async downloadFromUrl(url: string, accountId: string, fileName: string): Promise<string | null> {
    try {
      const axios = require('axios');
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      const filePath = await this.storage.saveFile(buffer, fileName, accountId);
      return filePath;
    } catch (err) {
      logger.error({ err, url, accountId }, 'Failed to download media from URL');
      return null;
    }
  }

  private getExtensionFromMimeType(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'audio/mpeg': '.mp3',
      'audio/ogg': '.ogg',
      'audio/wav': '.wav',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    };

    return mimeToExt[mimeType] || '.bin';
  }
}

