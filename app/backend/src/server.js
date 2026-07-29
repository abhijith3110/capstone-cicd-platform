const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'appdb',
};

let pool;
function getPool() {
  if (!pool) pool = mysql.createPool(dbConfig);
  return pool;
}

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'UP' });
});

app.get('/health/ready', async (req, res) => {
  try {
    const conn = await getPool().getConnection();
    await conn.ping();
    conn.release();
    res.status(200).json({ status: 'READY' });
  } catch (err) {
    res.status(503).json({ status: 'NOT_READY', error: err.message });
  }
});

app.get('/api/version', (req, res) => {
  res.json({
    version: process.env.APP_VERSION || 'dev',
    buildNumber: process.env.BUILD_NUMBER || 'local',
    env: process.env.NODE_ENV || 'development',
  });
});

app.get('/api/items', async (req, res) => {
  try {
    const [rows] = await getPool().query('SELECT id, name FROM items LIMIT 50');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB query failed', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend API listening on port ${PORT}`);
});
module.exports = app;
