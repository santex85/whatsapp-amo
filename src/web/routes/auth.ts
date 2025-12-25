import { Router, Request, Response } from 'express';
import { AmoCRMOAuth } from '../../amocrm/oauth';
import logger from '../../utils/logger';

export function createAuthRoutes(): Router {
  const router = Router();

  router.get('/auth/amocrm', (req: Request, res: Response): void => {
    try {
      const { account_id, subdomain } = req.query;

      if (!account_id || !subdomain) {
        res.status(400).json({ 
          error: 'Missing required parameters: account_id and subdomain' 
        });
        return;
      }

      const oauth = new AmoCRMOAuth(account_id as string, subdomain as string);
      const authUrl = oauth.getAuthorizationUrl();

      logger.info({ accountId: account_id, subdomain }, 'Redirecting to amoCRM OAuth');
      res.redirect(authUrl);
    } catch (err) {
      logger.error({ err }, 'Failed to initiate OAuth');
      res.status(500).json({ error: 'Failed to initiate OAuth' });
    }
  });

  router.get('/auth/amocrm/callback', async (req: Request, res: Response): Promise<void> => {
    try {
      const { code, state } = req.query;

      if (!code || !state) {
        res.status(400).json({ 
          error: 'Missing code or state parameter' 
        });
        return;
      }

      const [accountId, subdomain] = (state as string).split(':');
      
      if (!accountId || !subdomain) {
        res.status(400).json({ 
          error: 'Invalid state parameter' 
        });
        return;
      }

      const oauth = new AmoCRMOAuth(accountId, subdomain);
      await oauth.exchangeCodeForTokens(code as string);

      logger.info({ accountId, subdomain }, 'OAuth tokens obtained successfully');
      
      res.send(`
        <html>
          <head>
            <title>Авторизация успешна</title>
            <style>
              body {
                font-family: Arial, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: #f5f5f5;
              }
              .container {
                background: white;
                padding: 40px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                text-align: center;
              }
              h1 {
                color: #4CAF50;
                margin-bottom: 20px;
              }
              p {
                color: #666;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>✓ Авторизация успешна!</h1>
              <p>Токены сохранены. Вы можете закрыть это окно.</p>
            </div>
          </body>
        </html>
      `);
    } catch (err) {
      logger.error({ err }, 'OAuth callback error');
      res.status(500).send(`
        <html>
          <head>
            <title>Ошибка авторизации</title>
            <style>
              body {
                font-family: Arial, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: #f5f5f5;
              }
              .container {
                background: white;
                padding: 40px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                text-align: center;
              }
              h1 {
                color: #f44336;
                margin-bottom: 20px;
              }
              p {
                color: #666;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>✗ Ошибка авторизации</h1>
              <p>${err instanceof Error ? err.message : 'Неизвестная ошибка'}</p>
            </div>
          </body>
        </html>
      `);
    }
  });

  return router;
}

