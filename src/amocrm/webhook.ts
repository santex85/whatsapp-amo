import { Request, Response } from 'express';
import logger from '../utils/logger';
import { AmoCRMWebhookPayload } from './types';
import { AmoCRMError } from '../utils/errors';

export function validateWebhookRequest(req: Request): AmoCRMWebhookPayload {
  // Базовая валидация структуры запроса
  if (!req.body) {
    throw new AmoCRMError('Empty request body', 'INVALID_REQUEST', 400);
  }

  const { account_id, chat_id, message } = req.body;

  if (!account_id || !chat_id || !message) {
    throw new AmoCRMError('Missing required fields', 'INVALID_REQUEST', 400);
  }

  if (!message.content) {
    throw new AmoCRMError('Message content is required', 'INVALID_REQUEST', 400);
  }

  return req.body as AmoCRMWebhookPayload;
}

export function handleAmoCRMWebhook(
  req: Request,
  res: Response,
  onMessage: (payload: AmoCRMWebhookPayload) => Promise<void>
): void {
  try {
    const payload = validateWebhookRequest(req);
    
    logger.info(
      { 
        accountId: payload.account_id, 
        chatId: payload.chat_id,
        hasAttachments: !!payload.message.attachments?.length 
      },
      'Webhook received from amoCRM'
    );

    // Обрабатываем асинхронно, чтобы быстро ответить amoCRM
    onMessage(payload).catch((err) => {
      logger.error({ err, payload }, 'Error processing webhook message');
    });

    // Отвечаем сразу, чтобы amoCRM не считал запрос неудачным
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    logger.error({ err, body: req.body }, 'Invalid webhook request');
    
    if (err instanceof AmoCRMError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

