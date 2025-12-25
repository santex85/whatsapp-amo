import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { WhatsAppManager } from '../../whatsapp/manager';
import logger from '../../utils/logger';

export function createQRRoutes(manager: WhatsAppManager): Router {
  const router = Router();

  router.get('/qr/:accountId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { accountId } = req.params;
      
      // Проверяем, существует ли аккаунт
      const accountStatus = manager.getAccountStatus(accountId);
      if (!accountStatus) {
        // Аккаунт не существует, возвращаем 404 с правильным Content-Type для изображения
        // Но браузер ожидает изображение, поэтому вернем прозрачный 1x1 PNG
        const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.status(404).send(transparentPng);
        return;
      }

      // Если аккаунт подключен, QR-код не нужен
      if (accountStatus.connected) {
        const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.send(transparentPng);
        return;
      }

      const qrCode = manager.getQRCode(accountId);

      if (!qrCode) {
        // QR-код еще не готов, возвращаем прозрачный PNG
        const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.send(transparentPng);
        return;
      }

      // Генерируем QR код как изображение
      const qrImage = await QRCode.toDataURL(qrCode);
      const base64Data = qrImage.split(',')[1];

      res.setHeader('Content-Type', 'image/png');
      res.send(Buffer.from(base64Data, 'base64'));
    } catch (err) {
      logger.error({ err, accountId: req.params.accountId }, 'Failed to generate QR code');
      // Возвращаем прозрачный PNG вместо JSON ошибки
      const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.status(500).send(transparentPng);
    }
  });

  router.get('/qr/:accountId/data', async (req: Request, res: Response): Promise<void> => {
    try {
      const { accountId } = req.params;
      
      // Проверяем, существует ли аккаунт
      let accountStatus = manager.getAccountStatus(accountId);
      
      // Если аккаунт не существует, пытаемся его создать
      if (!accountStatus) {
        try {
          logger.info({ accountId }, 'Account not found, creating new account');
          await manager.addAccount(accountId);
          accountStatus = manager.getAccountStatus(accountId);
        } catch (err) {
          logger.error({ err, accountId }, 'Failed to create account');
          res.status(500).json({ error: 'Failed to create account', details: err instanceof Error ? err.message : 'Unknown error' });
          return;
        }
      }

      // Если аккаунт подключен, QR-код не нужен
      if (accountStatus && accountStatus.connected) {
        res.status(404).json({ error: 'Account is already connected' });
        return;
      }

      const qrCode = manager.getQRCode(accountId);

      if (!qrCode) {
        res.status(404).json({ error: 'QR code not ready yet. Please wait a moment and try again.' });
        return;
      }

      res.json({ qr: qrCode });
    } catch (err) {
      logger.error({ err, accountId: req.params.accountId }, 'Failed to get QR code data');
      res.status(500).json({ error: 'Failed to get QR code', details: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  return router;
}

