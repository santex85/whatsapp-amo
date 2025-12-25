import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { promises as fs } from 'fs';
import path from 'path';
import logger from '../utils/logger';

/**
 * Используем встроенное хранение Baileys в файловой системе.
 * Сессия каждого аккаунта хранится в ./storage/sessions/<accountId>
 */
export async function createAuthState(accountId: string) {
  const baseDir = path.resolve('./storage/sessions', accountId);
  await fs.mkdir(baseDir, { recursive: true });
  const state = await useMultiFileAuthState(baseDir);
  logger.debug({ accountId, baseDir }, 'Auth state initialized');
  return state;
}

