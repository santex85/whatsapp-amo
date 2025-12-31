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

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS amocrm_conversations (
      account_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (account_id, phone_number),
      FOREIGN KEY (account_id) REFERENCES amocrm_tokens(account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_amocrm_tokens_expires_at ON amocrm_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_amocrm_conversations_lookup ON amocrm_conversations(account_id, phone_number);
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

/**
 * Инициализирует первого администратора из переменных окружения
 * Вызывается после initDatabase()
 * Администратор создается ТОЛЬКО если данные есть в .env
 */
export async function initDefaultAdmin(): Promise<void> {
  try {
    // Проверяем наличие пользователей
    if (hasUsers()) {
      logger.info('✅ Users already exist, skipping admin creation');
      return;
    }

    // Получаем данные из .env (обязательно, без дефолтов)
    const adminUsernameEnv = process.env.ADMIN_USERNAME;
    const adminPasswordEnv = process.env.ADMIN_PASSWORD;
    
    // Проверяем наличие обязательных переменных
    if (!adminUsernameEnv || !adminPasswordEnv) {
      logger.warn('');
      logger.warn('═══════════════════════════════════════════════════════');
      logger.warn('⚠️  ADMIN CREDENTIALS NOT FOUND IN .env');
      logger.warn('═══════════════════════════════════════════════════════');
      logger.warn('');
      logger.warn('To create admin user, add to .env file:');
      logger.warn('');
      logger.warn('  ADMIN_USERNAME=your_username');
      logger.warn('  ADMIN_PASSWORD=your_secure_password');
      logger.warn('  SESSION_SECRET=your_session_secret_key');
      logger.warn('');
      logger.warn('Example:');
      logger.warn('  ADMIN_USERNAME=admin');
      logger.warn('  ADMIN_PASSWORD=MySecurePassword123!');
      logger.warn('  SESSION_SECRET=super-secret-key-change-in-production');
      logger.warn('');
      logger.warn('After adding credentials:');
      logger.warn('  1. Save .env file');
      logger.warn('  2. Restart the server');
      logger.warn('  3. Admin user will be created automatically');
      logger.warn('');
      logger.warn('═══════════════════════════════════════════════════════');
      logger.warn('');
      return;
    }

    logger.info({ 
      username: adminUsernameEnv,
      passwordLength: adminPasswordEnv.length,
    }, 'Creating admin user from .env credentials...');
    
    await createUser(adminUsernameEnv, adminPasswordEnv);
    logger.info({ username: adminUsernameEnv }, '✅ Admin user created successfully from .env');
  } catch (err: any) {
    // Если пользователь уже существует (например, создан вручную), это нормально
    if (err?.message?.includes('UNIQUE constraint')) {
      logger.info({ username: process.env.ADMIN_USERNAME }, '✅ Admin user already exists');
    } else {
      logger.error({ 
        err, 
        errorMessage: err?.message,
        errorStack: err?.stack,
        username: process.env.ADMIN_USERNAME
      }, '❌ Failed to create admin user');
    }
  }
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

// Users
export interface User {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
}

/**
 * Создает пользователя с хешированием пароля
 * @param username - имя пользователя
 * @param password - пароль (будет захеширован)
 */
export async function createUser(username: string, password: string): Promise<void> {
  const bcrypt = await import('bcrypt');
  const database = getDatabase();
  const passwordHash = await bcrypt.hash(password, 10);
  
  database.prepare(`
    INSERT INTO users (username, password_hash, updated_at)
    VALUES (?, ?, strftime('%s', 'now'))
  `).run(username, passwordHash);
  
  logger.info({ username }, 'User created');
}

/**
 * Получает пользователя по имени
 * @param username - имя пользователя
 * @returns пользователь или null
 */
export function getUserByUsername(username: string): User | null {
  const database = getDatabase();
  const row = database.prepare(
    'SELECT id, username, password_hash, created_at, updated_at FROM users WHERE username = ? LIMIT 1'
  ).get(username) as User | undefined;
  return row || null;
}

/**
 * Проверяет пароль пользователя
 * @param username - имя пользователя
 * @param password - пароль для проверки
 * @returns true если пароль верный, false иначе
 */
export async function verifyPassword(username: string, password: string): Promise<boolean> {
  try {
    const user = getUserByUsername(username);
    if (!user) {
      logger.debug({ username }, 'User not found');
      return false;
    }
    
    const bcrypt = await import('bcrypt');
    const isValid = await bcrypt.compare(password, user.password_hash);
    
    if (!isValid) {
      logger.debug({ username }, 'Password mismatch');
    }
    
    return isValid;
  } catch (err) {
    logger.error({ err, username }, 'Error verifying password');
    throw err;
  }
}

/**
 * Проверяет наличие пользователей в БД
 * @returns true если есть хотя бы один пользователь
 */
export function hasUsers(): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number } | undefined;
  return (row?.count || 0) > 0;
}

/**
 * Сохраняет или обновляет conversation_id для аккаунта и номера телефона
 * @param accountId - ID аккаунта WhatsApp
 * @param phoneNumber - номер телефона
 * @param conversationId - conversation_id из amoCRM
 */
export function saveConversationId(accountId: string, phoneNumber: string, conversationId: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO amocrm_conversations (account_id, phone_number, conversation_id, updated_at)
    VALUES (?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(account_id, phone_number) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      updated_at = strftime('%s', 'now')
  `).run(accountId, phoneNumber, conversationId);
  logger.debug({ accountId, phoneNumber, conversationId }, 'Conversation ID saved');
}

/**
 * Получает conversation_id для аккаунта и номера телефона
 * @param accountId - ID аккаунта WhatsApp
 * @param phoneNumber - номер телефона
 * @returns conversation_id или null если не найден
 */
export function getConversationId(accountId: string, phoneNumber: string): string | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT conversation_id FROM amocrm_conversations
    WHERE account_id = ? AND phone_number = ?
    LIMIT 1
  `).get(accountId, phoneNumber) as { conversation_id: string } | undefined;
  return row?.conversation_id || null;
}

