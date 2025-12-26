import { Request, Response } from 'express';
import logger from '../utils/logger';
import { AmoCRMWebhookPayload } from './types';
import { AmoCRMError } from '../utils/errors';

export function validateWebhookRequest(req: Request): AmoCRMWebhookPayload {
  // Базовая валидация структуры запроса
  if (!req.body) {
    throw new AmoCRMError('Empty request body', 'INVALID_REQUEST', 400);
  }

  const { account_id, message } = req.body;

  if (!account_id || !message) {
    throw new AmoCRMError('Missing required fields: account_id or message', 'INVALID_REQUEST', 400);
  }

  // amoCRM отправляет данные в формате:
  // { account_id, message: { receiver: { phone, client_id }, message: { text } } }
  // Преобразуем в наш формат: { account_id, chat_id, message: { content } }
  
  let chat_id: string;
  let content: string;

  // Проверяем новый формат (с receiver и message.message.text)
  if (message.receiver && message.receiver.phone) {
    chat_id = message.receiver.phone;
    // Проверяем наличие текста в message.message.text
    if (message.message && message.message.text) {
      content = message.message.text;
    } else {
      throw new AmoCRMError('Message text is required (message.message.text)', 'INVALID_REQUEST', 400);
    }
  } 
  // Проверяем старый формат (для обратной совместимости)
  else if (req.body.chat_id && message.content) {
    chat_id = req.body.chat_id;
    content = message.content;
  } else {
    throw new AmoCRMError('Missing required fields: chat_id/receiver.phone or message.content/message.message.text', 'INVALID_REQUEST', 400);
  }

  // Возвращаем нормализованный формат
  return {
    account_id,
    chat_id,
    message: {
      content,
      attachments: message.message?.media ? [{
        url: message.message.media,
        type: message.message.type || 'unknown'
      }] : undefined
    }
  } as AmoCRMWebhookPayload;
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

