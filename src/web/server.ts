import express, { Express, Request, Response } from 'express';
import { WhatsAppManager } from '../whatsapp/manager';
import { createQRRoutes } from './routes/qr';
import { createAccountsRoutes } from './routes/accounts';
import { createWebhookRoutes } from './routes/webhook';
import { createAuthRoutes } from './routes/auth';
import { AmoCRMWebhookPayload } from '../amocrm/types';
import { getAccountIdByScopeId } from '../database/sqlite';
import { validateWebhookRequest } from '../amocrm/webhook';
import { AmoCRMError } from '../utils/errors';
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
    // Логируем только важные API запросы и webhook по scope_id
    if ((req.path.startsWith('/api/') && !req.path.includes('/qr/')) || req.path.startsWith('/location/')) {
      logger.info({ method: req.method, path: req.path }, '→ Запрос');
    }
    next();
  });

  // API routes
  app.use('/api', createAccountsRoutes(manager));
  app.use('/api', createQRRoutes(manager));
  app.use('/api', createWebhookRoutes(onWebhookMessage));
  app.use('/', createAuthRoutes());
  
  // Webhook endpoint по scope_id (без /api префикса, как указано в плане)
  // Endpoint: POST /location/:scopeId
  app.post('/location/:scopeId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { scopeId } = req.params;

      if (!scopeId) {
        res.status(400).json({ error: 'scope_id is required in URL path' });
        return;
      }

      logger.info({ scopeId }, '📥 Webhook получен по scope_id');

      // Находим account_id по scope_id
      const accountId = getAccountIdByScopeId(scopeId);

      if (!accountId) {
        logger.warn({ scopeId }, '⚠️ scope_id не найден в БД');
        res.status(404).json({ 
          error: 'scope_id not found',
          message: `No account found for scope_id: ${scopeId}. Please ensure /api/amocrm/connect was executed.`
        });
        return;
      }

      logger.info({ scopeId, accountId }, '✅ account_id найден по scope_id');

      // Валидируем payload от amoCRM
      let payload: AmoCRMWebhookPayload;
      try {
        payload = validateWebhookRequest(req);
      } catch (err) {
        if (err instanceof AmoCRMError) {
          res.status(err.statusCode).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }

      // Заменяем account_id из payload на найденный по scope_id
      const webhookPayload: AmoCRMWebhookPayload = {
        ...payload,
        account_id: accountId,
      };

      logger.info(
        { 
          scopeId, 
          accountId, 
          chatId: webhookPayload.chat_id,
          hasAttachments: !!webhookPayload.message.attachments?.length,
          messageLength: webhookPayload.message.content?.length || 0
        },
        '📤 Обработка webhook сообщения от amoCRM'
      );

      // Обрабатываем асинхронно, чтобы быстро ответить amoCRM
      onWebhookMessage(webhookPayload).catch((err) => {
        logger.error({ 
          err, 
          scopeId, 
          accountId, 
          chatId: webhookPayload.chat_id,
          errorMessage: err instanceof Error ? err.message : 'Unknown error',
          errorStack: err instanceof Error ? err.stack : undefined
        }, '❌ Ошибка обработки webhook сообщения');
      });

      // Отвечаем сразу, чтобы amoCRM не считал запрос неудачным
      res.status(200).json({ 
        status: 'ok', 
        account_id: accountId,
        scope_id: scopeId,
        message: 'Webhook received and queued for processing'
      });
    } catch (err) {
      logger.error({ err, scopeId: req.params.scopeId, body: req.body }, 'Invalid webhook request');
      
      if (err instanceof AmoCRMError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

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
        webhookByScope: '/location/:scopeId',
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

