import { RedisQueue } from './redis';
import { QueueMessage } from './types';
import logger from '../utils/logger';
import { EventEmitter } from 'events';

export class QueueProcessor extends EventEmitter {
  private queue: RedisQueue;
  private processing = false;
  private processors: Map<string, (message: QueueMessage) => Promise<void>> = new Map();

  constructor(queue: RedisQueue) {
    super();
    this.queue = queue;
  }

  registerProcessor(queueName: string, processor: (message: QueueMessage) => Promise<void>): void {
    this.processors.set(queueName, processor);
    logger.info({ queueName }, 'Processor registered');
  }

  async start(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    logger.info('Queue processor started');

    // Запускаем обработчики для каждой очереди
    for (const [queueName, processor] of this.processors.entries()) {
      this.processQueue(queueName, processor).catch((err) => {
        logger.error({ err, queueName }, 'Queue processing error');
      });
    }
  }

  async stop(): Promise<void> {
    this.processing = false;
    logger.info('Queue processor stopped');
  }

  private async processQueue(
    queueName: string,
    processor: (message: QueueMessage) => Promise<void>
  ): Promise<void> {
    while (this.processing) {
      try {
        const message = await this.queue.dequeue(`${queueName}:queue`, 5);
        
        if (!message) {
          continue;
        }

        logger.debug({ queueName, messageId: message.id }, 'Processing message');

        try {
          await processor(message);
          this.emit('processed', { queueName, messageId: message.id });
        } catch (err) {
          logger.error({ err, queueName, messageId: message.id }, 'Message processing failed');
          this.emit('error', { queueName, messageId: message.id, error: err });
          
          // Retry логика
          await this.queue.retry(message);
        }
      } catch (err) {
        logger.error({ err, queueName }, 'Queue processing error');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Пауза перед повтором
      }
    }
  }
}

