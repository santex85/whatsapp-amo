import { createClient, RedisClientType } from 'redis';
import { config } from '../config';
import logger from '../utils/logger';
import { QueueError } from '../utils/errors';
import { QueueMessage } from './types';

export class RedisQueue {
  private client: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private isConnected = false;

  async connect(): Promise<void> {
    if (this.isConnected && this.client) {
      return;
    }

    try {
      this.client = createClient({
        socket: {
          host: config.redis.host,
          port: config.redis.port,
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              logger.error('Redis: Max reconnection attempts reached');
              return new Error('Max reconnection attempts reached');
            }
            return Math.min(retries * 100, 3000);
          },
        },
      });

      this.subscriber = this.client.duplicate();

      this.client.on('error', (err) => {
        logger.error({ err }, 'Redis client error');
        this.isConnected = false;
      });

      this.subscriber.on('error', (err) => {
        logger.error({ err }, 'Redis subscriber error');
      });

      await this.client.connect();
      await this.subscriber.connect();
      this.isConnected = true;

      logger.info({ host: config.redis.host, port: config.redis.port }, 'Redis connected');
    } catch (err: any) {
      const errorMessage = err?.message || 'Unknown error';
      logger.error({ 
        err, 
        host: config.redis.host, 
        port: config.redis.port,
        message: errorMessage 
      }, 'Failed to connect to Redis');
      
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('Connection refused')) {
        logger.error(`
╔══════════════════════════════════════════════════════════════╗
║  Redis не запущен!                                           ║
╠══════════════════════════════════════════════════════════════╣
║  Запустите Redis одним из способов:                          ║
║                                                               ║
║  1. macOS (Homebrew):                                         ║
║     brew services start redis                                 ║
║                                                               ║
║  2. Или вручную:                                             ║
║     redis-server                                             ║
║                                                               ║
║  3. Или через npm скрипт:                                    ║
║     npm run redis:start                                      ║
║                                                               ║
║  4. Или через Docker:                                        ║
║     docker run -d -p 6379:6379 redis:7-alpine                ║
║                                                               ║
║  Подробнее: см. REDIS_SETUP.md                               ║
╚══════════════════════════════════════════════════════════════╝
        `);
      }
      
      throw new QueueError(`Failed to connect to Redis at ${config.redis.host}:${config.redis.port}. ${errorMessage}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    this.isConnected = false;
    logger.info('Redis disconnected');
  }

  async enqueue(queueName: string, message: QueueMessage): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new QueueError('Redis not connected');
    }

    try {
      const serialized = JSON.stringify(message);
      await this.client.lPush(queueName, serialized);
      logger.debug({ queueName, messageId: message.id }, 'Message enqueued');
    } catch (err) {
      logger.error({ err, queueName }, 'Failed to enqueue message');
      throw new QueueError('Failed to enqueue message');
    }
  }

  async dequeue(queueName: string, timeout: number = 0): Promise<QueueMessage | null> {
    if (!this.client || !this.isConnected) {
      throw new QueueError('Redis not connected');
    }

    try {
      const result = await this.client.brPop(
        this.client.commandOptions({ isolated: true }),
        queueName,
        timeout
      );

      if (!result) {
        return null;
      }

      const message = JSON.parse(result.element) as QueueMessage;
      logger.debug({ queueName, messageId: message.id }, 'Message dequeued');
      return message;
    } catch (err) {
      logger.error({ err, queueName }, 'Failed to dequeue message');
      throw new QueueError('Failed to dequeue message');
    }
  }

  async getQueueLength(queueName: string): Promise<number> {
    if (!this.client || !this.isConnected) {
      return 0;
    }

    try {
      return await this.client.lLen(queueName);
    } catch (err) {
      logger.error({ err, queueName }, 'Failed to get queue length');
      return 0;
    }
  }

  async subscribe(queueName: string, callback: (message: QueueMessage) => void): Promise<void> {
    if (!this.subscriber || !this.isConnected) {
      throw new QueueError('Redis subscriber not connected');
    }

    await this.subscriber.subscribe(queueName, (message) => {
      try {
        const queueMessage = JSON.parse(message) as QueueMessage;
        callback(queueMessage);
      } catch (err) {
        logger.error({ err }, 'Failed to parse subscribed message');
      }
    });

    logger.info({ queueName }, 'Subscribed to queue');
  }

  async retry(message: QueueMessage, maxRetries: number = 3): Promise<void> {
    if ((message.retryCount || 0) >= maxRetries) {
      logger.error({ messageId: message.id }, 'Message exceeded max retries, moving to dead letter queue');
      await this.enqueue(`${message.type}:dead-letter`, message);
      return;
    }

    message.retryCount = (message.retryCount || 0) + 1;
    await this.enqueue(`${message.type}:queue`, message);
    logger.debug({ messageId: message.id, retryCount: message.retryCount }, 'Message retried');
  }
}

// Singleton instance
let queueInstance: RedisQueue | null = null;

export function getQueue(): RedisQueue {
  if (!queueInstance) {
    queueInstance = new RedisQueue();
  }
  return queueInstance;
}

