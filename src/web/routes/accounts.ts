import { Router, Request, Response } from 'express';
import { WhatsAppManager } from '../../whatsapp/manager';
import logger from '../../utils/logger';
import { connectChannel } from '../../amocrm/connect';
import { amocrmConfig } from '../../config/amocrm';
import { saveAmoCRMScopeId, getAmoCRMTokens } from '../../database/sqlite';

export function createAccountsRoutes(manager: WhatsAppManager): Router {
  const router = Router();

  router.get('/accounts', (_req: Request, res: Response) => {
    try {
      const statuses = manager.getAllAccountStatuses();
      res.json({ accounts: statuses });
    } catch (err) {
      logger.error({ err }, 'Failed to get accounts');
      res.status(500).json({ error: 'Failed to get accounts' });
    }
  });

  router.get('/accounts/:accountId', (req: Request, res: Response): void => {
    try {
      const { accountId } = req.params;
      const status = manager.getAccountStatus(accountId);

      if (!status) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }

      res.json({ account: status });
    } catch (err) {
      logger.error({ err, accountId: req.params.accountId }, 'Failed to get account');
      res.status(500).json({ error: 'Failed to get account' });
    }
  });

  router.post('/accounts/:accountId', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      
      await manager.addAccount(accountId);
      
      res.json({ 
        message: 'Account added successfully',
        accountId 
      });
    } catch (err) {
      logger.error({ err, accountId: req.params.accountId }, 'Failed to add account');
      res.status(500).json({ error: 'Failed to add account' });
    }
  });

  router.delete('/accounts/:accountId', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      
      await manager.removeAccount(accountId);
      
      res.json({ 
        message: 'Account removed successfully',
        accountId 
      });
    } catch (err) {
      logger.error({ err, accountId: req.params.accountId }, 'Failed to remove account');
      res.status(500).json({ error: 'Failed to remove account' });
    }
  });

  // Эндпоинт для получения scope_id (connect) - выполняется один раз при настройке
  router.post('/amocrm/connect', async (req: Request, res: Response): Promise<void> => {
    try {
      const { account_id, subdomain, amojo_account_id } = req.body;

      if (!account_id || !subdomain) {
        res.status(400).json({
          error: 'Missing account_id or subdomain in request body',
        });
        return;
      }

      // Проверяем, что токены уже получены (OAuth пройден)
      const tokens = getAmoCRMTokens(account_id);
      if (!tokens) {
        res.status(400).json({
          error: 'AmoCRM tokens not found. Please authorize first via /auth/amocrm',
        });
        return;
      }

      const { channelCode, channelSecret, amojoAccountId: envAmojoId, channelTitle } = amocrmConfig;
      if (!channelCode || !channelSecret) {
        res.status(400).json({
          error: 'Missing AMOCRM_CHANNEL_CODE / AMOCRM_CHANNEL_SECRET in .env',
        });
        return;
      }

      // Используем amojo_account_id из запроса, если передан, иначе из .env
      const finalAmojoAccountId = amojo_account_id || envAmojoId;
      if (!finalAmojoAccountId) {
        res.status(400).json({
          error: 'Missing amojo_account_id. Either set AMOCRM_AMOJO_ACCOUNT_ID in .env or pass amojo_account_id in request body',
          hint: 'Get it from browser console on amoCRM page: AMOCRM.constant("account").amojo_id',
        });
        return;
      }

      // Выполняем connect запрос
      const data = await connectChannel(
        account_id,
        subdomain,
        finalAmojoAccountId,
        channelTitle
      );

      // Согласно документации, scope_id может быть в формате {uuid1}_{uuid2}
      // Пример: 344a5002-f8ca-454d-af3d-396180102ac7_52e591f7-c98f-4255-8495-827210138c81
      // НЕ нормализуем scope_id - используем как есть из ответа connect
      const scopeId = data.scope_id;

      // Сохраняем scope_id в БД (как есть, без нормализации)
      saveAmoCRMScopeId(account_id, scopeId);

      logger.info({ accountId: account_id, scopeId }, `✅ scope_id сохранен: ${scopeId}`);

      res.json({
        success: true,
        scope_id: scopeId,
        account_id: data.account_id,
        title: data.title,
        message: 'scope_id успешно сохранен в базу данных. Теперь можно отправлять сообщения.',
      });
    } catch (err: any) {
      const errorMsg = err.message || 'Неизвестная ошибка';
      logger.error({ accountId: req.body.account_id || 'unknown', status: err.statusCode }, `❌ Ошибка подключения: ${errorMsg}`);
      res.status(err.statusCode || 500).json({
        error: err.message || 'Failed to connect channel',
      });
    }
  });

  return router;
}

