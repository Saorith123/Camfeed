// Run ONCE after deploying the new server.js:   node migrate-passwords.js
// Hashes every password that is still stored as plain text. Safe to run again (skips hashed rows).
require('dotenv').config();
const { Pool } = require('pg');
const auth = require('./auth');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query('ALTER TABLE users ALTER COLUMN password TYPE TEXT');
    const r = await pool.query("SELECT email, password FROM users WHERE password IS NOT NULL AND password NOT LIKE 'scrypt$%'");
    console.log(`Found ${r.rows.length} plain-text password(s) to hash...`);
    let done = 0;
    for (const row of r.rows) {
      const hash = await auth.hashPassword(row.password);
      // "AND password = $3" makes sure we never overwrite a password the user changed meanwhile
      const u = await pool.query('UPDATE users SET password = $1 WHERE email = $2 AND password = $3', [hash, row.email, row.password]);
      done += u.rowCount;
    }
    console.log(`Done. Hashed ${done} password(s).`);
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
