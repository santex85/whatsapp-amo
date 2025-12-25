import express, { Express, Request, Response } from 'express';
import { WhatsAppManager } from '../whatsapp/manager';
import { createQRRoutes } from './routes/qr';
import { createAccountsRoutes } from './routes/accounts';
import { createWebhookRoutes } from './routes/webhook';
import { createAuthRoutes } from './routes/auth';
import { AmoCRMWebhookPayload } from '../amocrm/types';
import logger from '../utils/logger';
import { config } from '../config';
import path from 'path';
import fs from 'fs';

export function createWebServer(
  manager: WhatsAppManager,
  onWebhookMessage: (payload: AmoCRMWebhookPayload) => Promise<void>
): Express {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Логирование важных запросов
  app.use((req, _res, next) => {
    // Логируем только важные API запросы
    if (req.path.startsWith('/api/') && !req.path.includes('/qr/')) {
      logger.info({ method: req.method, path: req.path }, '→ Запрос');
    }
    next();
  });

  // API routes
  app.use('/api', createAccountsRoutes(manager));
  app.use('/api', createQRRoutes(manager));
  app.use('/api', createWebhookRoutes(onWebhookMessage));
  app.use('/', createAuthRoutes());

  // QR page route - автоматически создает аккаунт при первом обращении
  app.get('/qr/:accountId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { accountId } = req.params;
      
      // Автоматически создаем аккаунт, если его еще нет
      let accountStatus = manager.getAccountStatus(accountId);
      if (!accountStatus) {
        try {
          logger.info({ accountId }, 'Account not found, creating new account');
          await manager.addAccount(accountId);
          accountStatus = manager.getAccountStatus(accountId);
        } catch (err) {
          logger.error({ err, accountId }, 'Failed to create account');
          res.status(500).send(`Failed to create account: ${err instanceof Error ? err.message : 'Unknown error'}`);
          return;
        }
      }
      
      const templatePath = path.join(__dirname, 'views', 'qr.html');
      
      if (!fs.existsSync(templatePath)) {
        res.status(404).send('QR template not found');
        return;
      }

      let html = fs.readFileSync(templatePath, 'utf-8');
      html = html.replace(/\{\{accountId\}\}/g, accountId);
      
      res.send(html);
    } catch (err) {
      logger.error({ err }, 'Failed to serve QR page');
      res.status(500).send('Internal server error');
    }
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Root
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'WhatsApp-amoCRM Gateway',
      version: '1.0.0',
      endpoints: {
        accounts: '/api/accounts',
        qr: '/qr/:accountId',
        webhook: '/api/webhook/amocrm',
        health: '/health',
      },
    });
  });

  return app;
}

export async function startWebServer(
  app: Express,
  port: number = config.server.port
): Promise<void> {
  // Принудительный вывод для отладки
  console.log('\n🌐 Запуск веб-сервера...');
  process.stdout.write(`[WEB] Запуск веб-сервера на порту ${port} (stdout)\n`);
  
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      // Принудительный вывод для отладки
      console.log(`\n✅ Сервер запущен на порту ${port}`);
      console.log(`🌐 API: http://localhost:${port}/api`);
      console.log(`📱 QR: http://localhost:${port}/qr/test-1`);
      console.log(`💚 Health: http://localhost:${port}/health\n`);
      process.stdout.write(`[WEB] Сервер запущен на порту ${port} (stdout)\n`);
      logger.info({ port }, '🚀 Сервер запущен');
      resolve();
    });

    server.on('error', (err) => {
      console.error(`\n❌ Ошибка запуска сервера: ${err.message}`);
      process.stderr.write(`[WEB] Ошибка запуска сервера: ${err.message}\n`);
      logger.error({ err, port }, 'Failed to start web server');
      reject(err);
    });
  });
}

