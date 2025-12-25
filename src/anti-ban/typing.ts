import { WhatsAppManager } from '../whatsapp/manager';
import { config } from '../config';
import logger from '../utils/logger';

export async function simulateTyping(
  manager: WhatsAppManager,
  accountId: string,
  to: string,
  duration?: number
): Promise<void> {
  try {
    const typingDuration = duration || config.antiBan.typingDurationMs;
    
    logger.debug({ accountId, to, duration: typingDuration }, 'Simulating typing');
    
    await manager.sendTyping(accountId, to, typingDuration);
    
    // Ждем завершения симуляции печати
    await new Promise(resolve => setTimeout(resolve, typingDuration));
  } catch (err) {
    logger.error({ err, accountId, to }, 'Failed to simulate typing');
    // Не бросаем ошибку, чтобы не прерывать отправку сообщения
  }
}

