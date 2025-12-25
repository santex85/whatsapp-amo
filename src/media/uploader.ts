import { WASocket } from '@whiskeysockets/baileys';
import { MediaStorage } from './storage';
import { AmoCRMAPI } from '../amocrm/api';
import logger from '../utils/logger';
import path from 'path';

export class MediaUploader {
  private storage: MediaStorage;

  constructor(storage: MediaStorage) {
    this.storage = storage;
  }

  async uploadToAmoCRM(
    amocrmAPI: AmoCRMAPI,
    filePath: string,
    accountId: string
  ): Promise<string> {
    try {
      const fileName = path.basename(filePath);
      
      // Определяем MIME тип по расширению
      const mimeType = this.getMimeType(fileName);

      const url = await amocrmAPI.uploadFile(filePath, fileName, mimeType);
      logger.info({ accountId, fileName, url }, 'Media uploaded to amoCRM');

      return url;
    } catch (err) {
      logger.error({ err, accountId, filePath }, 'Failed to upload media to amoCRM');
      throw err;
    }
  }

  async sendToWhatsApp(
    sock: WASocket,
    to: string,
    filePath: string,
    mimeType: string,
    caption?: string
  ): Promise<void> {
    try {
      const buffer = await this.storage.getFile(filePath);
      const fileName = path.basename(filePath);

      if (mimeType.startsWith('image/')) {
        await sock.sendMessage(to, {
          image: buffer,
          caption: caption,
        });
      } else if (mimeType.startsWith('video/')) {
        await sock.sendMessage(to, {
          video: buffer,
          caption: caption,
        });
      } else if (mimeType.startsWith('audio/')) {
        await sock.sendMessage(to, {
          audio: buffer,
          mimetype: mimeType,
        });
      } else {
        await sock.sendMessage(to, {
          document: buffer,
          mimetype: mimeType,
          fileName: fileName,
        });
      }

      logger.info({ to, fileName }, 'Media sent to WhatsApp');
    } catch (err) {
      logger.error({ err, to, filePath }, 'Failed to send media to WhatsApp');
      throw err;
    }
  }

  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }
}

