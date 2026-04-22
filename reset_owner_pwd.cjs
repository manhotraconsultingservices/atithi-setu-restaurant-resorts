const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const db = new Database('./database.sqlite');

const row = db.prepare('SELECT email, password_hash FROM owner_accounts WHERE LOWER(email) = ?').get('amanhotra86@gmail.com');
console.log('Found owner_accounts row:', JSON.stringify(row));

if (row) {
  const newHash = bcrypt.hashSync('Owner@2025', 12);
  db.prepare('UPDATE owner_accounts SET password_hash = ? WHERE LOWER(email) = ?').run(newHash, 'amanhotra86@gmail.com');
  console.log('Password updated to Owner@2025');
} else {
  const all = db.prepare('SELECT email FROM owner_accounts').all();
  console.log('All owner_accounts emails:', JSON.stringify(all));
}
db.close();
