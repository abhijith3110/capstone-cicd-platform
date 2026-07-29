const request = require('supertest');
const app = require('./server');

describe('Health endpoints', () => {
  it('GET /health/live returns 200', async () => {
    const res = await request(app).get('/health/live');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('UP');
  });

  it('GET /api/version returns version info', async () => {
    const res = await request(app).get('/api/version');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('version');
  });
});
