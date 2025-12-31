const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
require('dotenv').config();

const dbPath = path.join(__dirname, '..', 'storage', 'database', 'sessions.db');
const db = new Database(dbPath);

async function testLogin() {
  try {
    const testUsername = process.env.ADMIN_USERNAME || 'admin';
    const testPassword = process.env.ADMIN_PASSWORD;
    
    console.log('Testing login with:');
    console.log('  Username:', testUsername);
    console.log('  Password:', testPassword ? `${testPassword.substring(0, 3)}... (${testPassword.length} chars)` : 'NOT SET');
    
    if (!testPassword) {
      console.log('\n❌ ADMIN_PASSWORD not set in .env');
      return;
    }
    
    // Получаем пользователя из БД
    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(testUsername);
    
    if (!user) {
      console.log(`\n❌ User "${testUsername}" not found in database`);
      const users = db.prepare('SELECT username FROM users').all();
      console.log('Existing users:', users.map(u => u.username).join(', ') || 'none');
      return;
    }
    
    console.log(`\n✅ User "${testUsername}" found in database`);
    
    // Проверяем пароль
    const isValid = await bcrypt.compare(testPassword, user.password_hash);
    
    if (isValid) {
      console.log('✅ Password is CORRECT - login should work!');
    } else {
      console.log('❌ Password is INCORRECT - login will fail!');
      console.log('\nThe password in .env does not match the password in the database.');
      console.log('Possible reasons:');
      console.log('  1. .env was changed after user was created');
      console.log('  2. User was created with different password');
      console.log('\nSolution: Run "node scripts/reset-admin.js" and restart server');
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    db.close();
  }
}

testLogin();

