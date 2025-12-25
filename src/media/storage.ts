import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';
import logger from '../utils/logger';

export class MediaStorage {
  private storagePath: string;

  constructor() {
    this.storagePath = config.media.storagePath;
    this.ensureStorageExists();
  }

  private async ensureStorageExists(): Promise<void> {
    try {
      await fs.mkdir(this.storagePath, { recursive: true });
    } catch (err) {
      logger.error({ err }, 'Failed to create media storage directory');
    }
  }

  async saveFile(buffer: Buffer, fileName: string, accountId: string): Promise<string> {
    await this.ensureStorageExists();

    const accountDir = path.join(this.storagePath, accountId);
    await fs.mkdir(accountDir, { recursive: true });

    const filePath = path.join(accountDir, fileName);
    await fs.writeFile(filePath, buffer);

    logger.debug({ filePath, accountId }, 'File saved');
    return filePath;
  }

  async getFile(filePath: string): Promise<Buffer> {
    return await fs.readFile(filePath);
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
      logger.debug({ filePath }, 'File deleted');
    } catch (err) {
      logger.error({ err, filePath }, 'Failed to delete file');
    }
  }

  async cleanupOldFiles(maxAge: number = 24 * 60 * 60 * 1000): Promise<void> {
    try {
      const accounts = await fs.readdir(this.storagePath);
      const now = Date.now();

      for (const accountId of accounts) {
        const accountDir = path.join(this.storagePath, accountId);
        const stat = await fs.stat(accountDir);
        
        if (!stat.isDirectory()) {
          continue;
        }

        const files = await fs.readdir(accountDir);
        
        for (const file of files) {
          const filePath = path.join(accountDir, file);
          const fileStat = await fs.stat(filePath);
          
          if (now - fileStat.mtimeMs > maxAge) {
            await this.deleteFile(filePath);
          }
        }
      }

      logger.info('Media cleanup completed');
    } catch (err) {
      logger.error({ err }, 'Media cleanup error');
    }
  }

  getFilePath(accountId: string, fileName: string): string {
    return path.join(this.storagePath, accountId, fileName);
  }
}

