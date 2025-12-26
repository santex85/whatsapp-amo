import express, { Express, Request, Response } from 'express';
import { WhatsAppManager } from '../whatsapp/manager';
import { createQRRoutes } from './routes/qr';
import { createAccountsRoutes } from './routes/accounts';
import { createWebhookRoutes } from './routes/webhook';
import { createAuthRoutes } from './routes/auth';
import { createLoginRoutes } from './routes/login';
import { setupSessionMiddleware, requireAuth } from '../auth/session';
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

  // Настройка доверия к прокси (nginx) - должно быть первым
  app.set('trust proxy', 1);

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Настройка сессий (должно быть до других middleware)
  setupSessionMiddleware(app);

  // Логирование важных запросов
  app.use((req, _res, next) => {
    // Логируем только важные API запросы и webhook по scope_id
    if ((req.path.startsWith('/api/') && !req.path.includes('/qr/')) || req.path.startsWith('/location/')) {
      logger.info({ method: req.method, path: req.path }, '→ Запрос');
    }
    next();
  });

  // Публичные маршруты (не требуют авторизации)
  app.use('/', createLoginRoutes()); // Страница логина
  app.use('/', createAuthRoutes()); // OAuth для amoCRM
  
  // API routes (не требуют авторизации)
  app.use('/api', createAccountsRoutes(manager));
  app.use('/api', createQRRoutes(manager));
  app.use('/api', createWebhookRoutes(onWebhookMessage));
  
  // HTML страницы (без /api префикса, требуют авторизации)
  // Страница подключения amoCRM
  app.get('/amocrm/connect', (_req: Request, res: Response): void => {
    try {
      const templatePath = path.join(__dirname, 'views', 'amocrm-connect.html');
      
      if (!fs.existsSync(templatePath)) {
        res.status(404).send('Connect template not found');
        return;
      }

      const html = fs.readFileSync(templatePath, 'utf-8');
      res.send(html);
    } catch (err) {
      logger.error({ err }, 'Failed to serve amoCRM connect page');
      res.status(500).send('Internal server error');
    }
  });
  
  // Страница списка аккаунтов
  app.get('/accounts', (_req: Request, res: Response): void => {
    try {
      const templatePath = path.join(__dirname, 'views', 'accounts.html');
      
      if (!fs.existsSync(templatePath)) {
        res.status(404).send('Accounts template not found');
        return;
      }

      const html = fs.readFileSync(templatePath, 'utf-8');
      res.send(html);
    } catch (err) {
      logger.error({ err }, 'Failed to serve accounts page');
      res.status(500).send('Internal server error');
    }
  });
  
  // Страница деталей аккаунта
  app.get('/accounts/:accountId', (_req: Request, res: Response): void => {
    try {
      const templatePath = path.join(__dirname, 'views', 'account-detail.html');
      
      if (!fs.existsSync(templatePath)) {
        res.status(404).send('Account detail template not found');
        return;
      }

      const html = fs.readFileSync(templatePath, 'utf-8');
      res.send(html);
    } catch (err) {
      logger.error({ err }, 'Failed to serve account detail page');
      res.status(500).send('Internal server error');
    }
  });
  
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
        logger.info({ body: req.body }, '🔍 Валидация webhook payload');
        payload = validateWebhookRequest(req);
        logger.info({ accountId: payload.account_id, chatId: payload.chat_id, hasMessage: !!payload.message }, '✅ Payload валидирован');
      } catch (err) {
        logger.error({ err, body: req.body, errorMessage: err instanceof Error ? err.message : 'Unknown' }, '❌ Ошибка валидации webhook payload');
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
          messageLength: webhookPayload.message.content?.length || 0,
          messagePreview: webhookPayload.message.content?.substring(0, 50)
        },
        '📤 Обработка webhook сообщения от amoCRM'
      );

      // Обрабатываем асинхронно, чтобы быстро ответить amoCRM
      onWebhookMessage(webhookPayload).catch((err) => {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        const errorStack = err instanceof Error ? err.stack : undefined;
        logger.error({ 
          err, 
          scopeId, 
          accountId, 
          chatId: webhookPayload.chat_id,
          errorMessage,
          errorStack
        }, '❌ Ошибка обработки webhook сообщения');
        console.error(`[ERROR] Webhook processing failed: ${errorMessage}`, err);
      });

      // Отвечаем сразу, чтобы amoCRM не считал запрос неудачным
      // Упрощенный формат ответа для amoCRM
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      logger.error({ err, scopeId: req.params.scopeId, body: req.body }, 'Invalid webhook request');
      
      if (err instanceof AmoCRMError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Защищенные маршруты (требуют авторизации)
  // Применяем requireAuth ко всем GET маршрутам кроме исключений
  app.use((req, res, next) => {
    // Исключения: API JSON endpoints, webhook, login, OAuth callback, health JSON
    if (
      req.path.startsWith('/location/') ||
      req.path === '/login' ||
      req.path.startsWith('/auth/amocrm/')
    ) {
      return next();
    }
    
    // Для JSON API endpoints (с явным Accept: application/json) не требуем авторизации
    if (req.path.startsWith('/api/') && req.get('Accept')?.includes('application/json')) {
      return next();
    }
    
    // Для health с JSON тоже не требуем (для API совместимости)
    if (req.path === '/health' && req.get('Accept')?.includes('application/json')) {
      return next();
    }
    
    // Для всех остальных GET запросов требуется авторизация
    if (req.method === 'GET') {
      return requireAuth(req, res, next);
    }
    
    next();
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

  // Health check - HTML страница
  app.get('/health', async (req: Request, res: Response): Promise<void> => {
    // Если запрос с Accept: application/json, возвращаем JSON с детальной информацией
    if (req.get('Accept')?.includes('application/json')) {
      try {
        const { getAmoCRMTokens } = await import('../database/sqlite');
        const accounts = manager.getAllAccountStatuses();
        
        const accountsWithStatus = accounts.map(account => {
          const tokens = getAmoCRMTokens(account.accountId);
          
          return {
            accountId: account.accountId,
            whatsapp: {
              connected: account.connected,
              lastError: account.lastError || null,
            },
            amocrm: {
              hasTokens: !!tokens,
              hasScopeId: !!(tokens?.scope_id),
              scopeId: tokens?.scope_id || null,
              tokenExpiresAt: tokens?.expires_at ? new Date(tokens.expires_at).toISOString() : null,
              tokenValid: tokens?.expires_at ? tokens.expires_at > Date.now() : false,
            }
          };
        });
        
        res.json({ 
          status: 'ok', 
          timestamp: new Date().toISOString(),
          accounts: accountsWithStatus,
          summary: {
            totalAccounts: accounts.length,
            whatsappConnected: accounts.filter(a => a.connected).length,
            amocrmConfigured: accountsWithStatus.filter(a => a.amocrm.hasTokens && a.amocrm.hasScopeId).length,
          }
        });
      } catch (err) {
        logger.error({ err }, 'Failed to get health status');
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
      }
      return;
    }
    
    // Иначе возвращаем HTML страницу
    try {
      const templatePath = path.join(__dirname, 'views', 'health.html');
      
      if (!fs.existsSync(templatePath)) {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
        return;
      }

      const html = fs.readFileSync(templatePath, 'utf-8');
      res.send(html);
    } catch (err) {
      logger.error({ err }, 'Failed to serve health page');
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    }
  });

  // Root - Dashboard (требует авторизации)
  app.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const templatePath = path.join(__dirname, 'views', 'dashboard.html');
      
      if (!fs.existsSync(templatePath)) {
        res.status(404).send('Dashboard template not found');
        return;
      }

      let html = fs.readFileSync(templatePath, 'utf-8');
      
      // Подставляем имя пользователя из сессии
      const username = req.session?.username || 'admin';
      html = html.replace(/<strong id="username">admin<\/strong>/, `<strong id="username">${username}</strong>`);
      
      res.send(html);
    } catch (err) {
      logger.error({ err }, 'Failed to serve dashboard');
      res.status(500).send('Internal server error');
    }
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

