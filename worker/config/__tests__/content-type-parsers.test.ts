import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
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

  // The Twilio handlers validate the request signature over request.rawBody, so
  // the parser must NOT break rawBody capture by fastify-raw-body. Mirrors the
  // production registration order (raw-body plugin runFirst, then the parser).
  it('preserves rawBody capture for form-urlencoded (Twilio signature depends on it)', async () => {
    const app = Fastify();
    await app.register(rawBody, { field: 'rawBody', global: false, encoding: 'utf8', runFirst: true });
    registerIngressContentTypeParsers(app);
    app.post('/t', { config: { rawBody: true } }, async (req) => ({
      rawBody: (req as unknown as { rawBody?: string }).rawBody ?? null,
    }));

    const payload = 'MessageSid=SMx&From=whatsapp%3A%2B1&Body=start-abc';
    const res = await app.inject({
      method: 'POST',
      url: '/t',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).rawBody).toBe(payload);
    await app.close();
  });
});
