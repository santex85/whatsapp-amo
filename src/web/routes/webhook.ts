import { Router } from 'express';
import { handleAmoCRMWebhook } from '../../amocrm/webhook';
import { AmoCRMWebhookPayload } from '../../amocrm/types';

export function createWebhookRoutes(
  onWebhookMessage: (payload: AmoCRMWebhookPayload) => Promise<void>
): Router {
  const router = Router();

  // Существующий endpoint для webhook (через /api)
  router.post('/webhook/amocrm', (req, res) => {
    handleAmoCRMWebhook(req, res, onWebhookMessage);
  });

  return router;
}

