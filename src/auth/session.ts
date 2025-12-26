import session from 'express-session';
import { Express, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import logger from '../utils/logger';

// Расширяем типы для express-session
declare module 'express-session' {
  interface SessionData {
    isAuthenticated?: boolean;
    username?: string;
  }
}

/**
 * Настраивает middleware для сессий
 * @param app - Express приложение
 */
export function setupSessionMiddleware(app: Express): void {
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: config.server.nodeEnv === 'production', // HTTPS only в production
        httpOnly: true, // Защита от XSS
        maxAge: 24 * 60 * 60 * 1000, // 24 часа
        sameSite: 'lax', // Защита от CSRF (lax для лучшей совместимости)
      },
      name: 'whatsapp-amo.sid', // Имя cookie
    })
  );

  logger.info('Session middleware configured');
}

/**
 * Проверяет, авторизован ли пользователь
 * @param req - Express request
 * @returns true если пользователь авторизован
 */
export function isAuthenticated(req: Request): boolean {
  return req.session?.isAuthenticated === true;
}

/**
 * Middleware для проверки авторизации
 * Редиректит на /login если пользователь не авторизован
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
  } else {
    // Сохраняем оригинальный URL для редиректа после логина
    const redirectUrl = req.originalUrl || '/';
    res.redirect(`/login?redirect=${encodeURIComponent(redirectUrl)}`);
  }
}

