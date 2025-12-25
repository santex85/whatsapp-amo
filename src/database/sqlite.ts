import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config';
import logger from '../utils/logger';
import { promises as fs } from 'fs';
import path from 'path';

let db: DatabaseType | null = null;

export function initDatabase(): DatabaseType {
  if (db) {
    return db;
  }

  const dbPath = config.database.path;
  const dbDir = path.dirname(dbPath);

  // Создаем директорию если не существует
  fs.mkdir(dbDir, { recursive: true }).catch((err) => {
    logger.error({ err }, 'Failed to create database directory');
  });

  db = new Database(dbPath);
  
  // Включаем WAL режим для лучшей производительности
  db.pragma('journal_mode = WAL');

  // Создаем таблицы
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      account_id TEXT PRIMARY KEY,
      session_data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS amocrm_tokens (
      account_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      subdomain TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_amocrm_tokens_expires_at ON amocrm_tokens(expires_at);
  `);

  // Миграция: добавляем колонку scope_id если её нет
  try {
    const tableInfo = db.pragma('table_info(amocrm_tokens)') as Array<{ name: string; type: string }>;
    const hasScopeId = tableInfo.some(col => col.name === 'scope_id');
    
    if (!hasScopeId) {
      db.exec('ALTER TABLE amocrm_tokens ADD COLUMN scope_id TEXT');
      logger.info('Migration: Added scope_id column to amocrm_tokens table');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to check/add scope_id column, continuing anyway');
  }

  logger.info('Database initialized');
  return db;
}

export function getDatabase(): DatabaseType {
  if (!db) {
    return initDatabase();
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}

// WhatsApp sessions
export function saveWhatsAppSession(accountId: string, sessionData: string): void {
  const database = getDatabase();
  database.prepare(`
    INSERT INTO whatsapp_sessions (account_id, session_data, updated_at)
    VALUES (?, ?, strftime('%s', 'now'))
    ON CONFLICT(account_id) DO UPDATE SET
      session_data = excluded.session_data,
      updated_at = strftime('%s', 'now')
  `).run(accountId, sessionData);
}

export function getWhatsAppSession(accountId: string): string | null {
  const database = getDatabase();
  const row = database.prepare('SELECT session_data FROM whatsapp_sessions WHERE account_id = ?').get(accountId) as { session_data: string } | undefined;
  return row?.session_data || null;
}

export function deleteWhatsAppSession(accountId: string): void {
  const database = getDatabase();
  database.prepare('DELETE FROM whatsapp_sessions WHERE account_id = ?').run(accountId);
}

// AmoCRM tokens
export interface AmoCRMTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  subdomain: string;
  scope_id?: string;
}

export function saveAmoCRMTokens(accountId: string, tokens: AmoCRMTokens): void {
  const database = getDatabase();
  database.prepare(`
    INSERT INTO amocrm_tokens (account_id, access_token, refresh_token, expires_at, subdomain, scope_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(account_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      subdomain = excluded.subdomain,
      scope_id = excluded.scope_id,
      updated_at = strftime('%s', 'now')
  `).run(
    accountId,
    tokens.access_token,
    tokens.refresh_token,
    tokens.expires_at,
    tokens.subdomain,
    tokens.scope_id || null
  );
}

export function getAmoCRMTokens(accountId: string): AmoCRMTokens | null {
  const database = getDatabase();
  const row = database.prepare('SELECT access_token, refresh_token, expires_at, subdomain, scope_id FROM amocrm_tokens WHERE account_id = ?')
    .get(accountId) as AmoCRMTokens | undefined;
  return row || null;
}

export function saveAmoCRMScopeId(accountId: string, scopeId: string): void {
  const database = getDatabase();
  // Используем INSERT OR REPLACE, чтобы гарантировать, что scope_id будет сохранен
  // даже если запись существует, но scope_id был NULL
  const result = database.prepare(`
    UPDATE amocrm_tokens 
    SET scope_id = ?, updated_at = strftime('%s', 'now')
    WHERE account_id = ?
  `).run(scopeId, accountId);
  
  // Если UPDATE не обновил ни одной строки, значит записи нет
  // В этом случае нужно создать запись (но обычно запись должна существовать из saveAmoCRMTokens)
  if (result.changes === 0) {
    logger.warn({ accountId }, '⚠️ Запись amocrm_tokens не найдена при сохранении scope_id. Возможно, нужно сначала сохранить токены через saveAmoCRMTokens.');
  }
}

export function deleteAmoCRMTokens(accountId: string): void {
  const database = getDatabase();
  database.prepare('DELETE FROM amocrm_tokens WHERE account_id = ?').run(accountId);
}

/**
 * Находит account_id по scope_id
 * @param scopeId - scope_id из amoCRM
 * @returns account_id или null, если не найден
 */
export function getAccountIdByScopeId(scopeId: string): string | null {
  const database = getDatabase();
  const row = database.prepare(
    'SELECT account_id FROM amocrm_tokens WHERE scope_id = ? LIMIT 1'
  ).get(scopeId) as { account_id: string } | undefined;
  return row?.account_id || null;
}

