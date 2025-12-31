const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'storage', 'database', 'sessions.db');
const db = new Database(dbPath);

try {
  const users = db.prepare('SELECT id, username, created_at FROM users').all();
  console.log('Users in database:');
  console.log(JSON.stringify(users, null, 2));
  
  if (users.length === 0) {
    console.log('\n⚠️ No users found in database');
  }
} catch (err) {
  console.error('Error:', err.message);
} finally {
  db.close();
}

