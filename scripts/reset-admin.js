const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const dbPath = path.join(__dirname, '..', 'storage', 'database', 'sessions.db');
const db = new Database(dbPath);

try {
  // Показываем текущих пользователей
  console.log('Current users:');
  const users = db.prepare('SELECT id, username, created_at FROM users').all();
  console.log(JSON.stringify(users, null, 2));
  
  // Удаляем всех пользователей
  const result = db.prepare('DELETE FROM users').run();
  console.log(`\n✅ Deleted ${result.changes} user(s) from database`);
  
  console.log('\n⚠️  Now restart the server to create admin user from .env:');
  console.log('   ADMIN_USERNAME:', process.env.ADMIN_USERNAME || 'admin');
  console.log('   ADMIN_PASSWORD:', process.env.ADMIN_PASSWORD ? '***' : 'NOT SET');
  
} catch (err) {
  console.error('Error:', err.message);
} finally {
  db.close();
}

