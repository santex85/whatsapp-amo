import { Router, Request, Response } from 'express';
import { verifyPassword } from '../../database/sqlite';
import { isAuthenticated } from '../../auth/session';
import logger from '../../utils/logger';
import path from 'path';
import fs from 'fs';

export function createLoginRoutes(): Router {
  const router = Router();

  // Страница логина
  router.get('/login', (req: Request, res: Response): void => {
    // Если уже авторизован, редирект на главную (dashboard)
    if (isAuthenticated(req)) {
      res.redirect('/');
      return;
    }

    const templatePath = path.join(__dirname, '..', 'views', 'login.html');
    
    if (!fs.existsSync(templatePath)) {
      res.status(404).send('Login template not found');
      return;
    }

    const html = fs.readFileSync(templatePath, 'utf-8');
    res.send(html);
  });

  // Обработка формы входа
  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
      // Детальное логирование для отладки
      const contentType = req.get('Content-Type') || 'no-content-type';
      const bodyKeys = Object.keys(req.body || {});
      const bodyString = JSON.stringify(req.body);
      
      logger.info({ 
        contentType,
        bodyType: typeof req.body,
        bodyKeys,
        bodyString,
        bodyLength: bodyString.length,
        hasBody: !!req.body,
        method: req.method,
        path: req.path,
      }, '🔍 Login request debug info');
      
      const { username, password, redirect: redirectFromBody } = req.body || {};
      // По умолчанию редиректим на главную страницу (dashboard)
      const redirectUrl = (req.query.redirect as string) || redirectFromBody || '/';

      logger.info({ 
        username: username || 'empty', 
        hasPassword: !!password,
        hasUsername: !!username,
        bodyKeys,
        contentType,
      }, 'Login attempt');

      if (!username || !password) {
        logger.warn({ username: username || 'empty', hasPassword: !!password }, 'Login attempt with missing credentials');
        res.status(400).send(`
          <html>
            <head>
              <title>Ошибка входа</title>
              <meta http-equiv="refresh" content="2;url=/login">
            </head>
            <body>
              <p>Пожалуйста, введите имя пользователя и пароль</p>
              <p>Перенаправление...</p>
            </body>
          </html>
        `);
        return;
      }

      logger.debug({ username }, 'Verifying password');
      const isValid = await verifyPassword(username, password);
      logger.debug({ username, isValid }, 'Password verification result');

      if (isValid) {
        // Устанавливаем сессию
        if (!req.session) {
          logger.error('Session not available');
          throw new Error('Session not initialized');
        }

        req.session.isAuthenticated = true;
        req.session.username = username;

        logger.info({ username }, '✅ User logged in successfully');
        
        res.redirect(redirectUrl);
      } else {
        logger.warn({ username }, '❌ Failed login attempt - invalid credentials');
        
        res.status(401).send(`
          <html>
            <head>
              <title>Ошибка входа</title>
              <meta http-equiv="refresh" content="3;url=/login">
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
                <h1>✗ Неверный логин или пароль</h1>
                <p>Перенаправление на страницу входа...</p>
              </div>
            </body>
          </html>
        `);
      }
    } catch (err) {
      logger.error({ 
        err, 
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
        errorStack: err instanceof Error ? err.stack : undefined,
        username: req.body?.username || 'unknown'
      }, '❌ Login error');
      
      res.status(500).send(`
        <html>
          <head>
            <title>Ошибка сервера</title>
            <meta http-equiv="refresh" content="3;url=/login">
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
              <h1>✗ Ошибка сервера</h1>
              <p>Попробуйте позже или обратитесь к администратору</p>
              <p>Перенаправление на страницу входа...</p>
            </div>
          </body>
        </html>
      `);
    }
  });

  // Выход из системы
  router.post('/logout', (req: Request, res: Response): void => {
    const username = req.session?.username;
    
    req.session.destroy((err) => {
      if (err) {
        logger.error({ err }, 'Logout error');
      } else {
        logger.info({ username }, 'User logged out');
      }
      res.redirect('/login');
    });
  });

  return router;
}

