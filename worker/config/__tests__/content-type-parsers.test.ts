import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerIngressContentTypeParsers } from '../content-type-parsers';

// Regression for the Twilio WhatsApp 415: Fastify rejects unparseable content
// types with 415 *before* the handler runs. Twilio webhooks POST
// application/x-www-form-urlencoded, so without a parser the ingress routes
// 415 every real webhook (the handler tests bypass Fastify's content-type
// gate by calling handlers directly, which is why this slipped through).
describe('registerIngressContentTypeParsers', () => {
  it('accepts application/x-www-form-urlencoded instead of returning 415', async () => {
    const app = Fastify();
    registerIngressContentTypeParsers(app);
    app.post('/t', async (req) => ({ body: req.body }));

    const res = await app.inject({
      method: 'POST',
      url: '/t',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'Body=hi&From=whatsapp%3A%2B1',
    });

    expect(res.statusCode).toBe(200); // not 415
    expect(JSON.parse(res.body).body).toBe('Body=hi&From=whatsapp%3A%2B1');
    await app.close();
  });

  it('matches the "; charset=UTF-8" parameter Twilio appends', async () => {
    const app = Fastify();
    registerIngressContentTypeParsers(app);
    app.post('/t', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'POST',
      url: '/t',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      payload: 'x=1',
    });

    expect(res.statusCode).toBe(200); // not 415
    await app.close();
  });
});
