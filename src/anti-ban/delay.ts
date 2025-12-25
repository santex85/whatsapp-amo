import { config } from '../config';
import logger from '../utils/logger';

export async function randomDelay(): Promise<void> {
  const min = config.antiBan.minDelayMs;
  const max = config.antiBan.maxDelayMs;
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;

  logger.debug({ delay }, 'Applying random delay');
  await new Promise(resolve => setTimeout(resolve, delay));
}

export async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

