import { createHmac } from 'node:crypto';

import { describe, it, expect, vi } from 'vitest';

import {
  CloudflareStreamAdapter,
  verifyStreamWebhook,
  streamConfig,
  VIDEO_LIMITS,
  STREAM_SDK,
  streamPlaybackDescriptor,
  validateUploadUrl,
} from '../stream.js';
import { previewConfig, previewHeaders } from '../preview.js';
import { streamOriginsAllowed } from '../stream-origins.js';
const id = 'a'.repeat(32),
  intent = '11111111-1111-4111-8111-111111111111';
const config = {
  accountId: 'b'.repeat(32),
  apiToken: 'unit-only-not-real',
  webhookSecret: 'unit-only-webhook-secret',
  customerHost: 'customer-fixture.cloudflarestream.com',
  allowedOrigins: ['*.vsl-preview.test'],
};
const meta = {
  uid: id,
  creator: `vsl-${intent}`,
  modified: '2026-09-27T12:00:00Z',
  readyToStream: true,
  status: { state: 'ready' },
  duration: 60,
  size: 1024,
  input: { width: 640, height: 360 },
  allowedOrigins: config.allowedOrigins,
};
describe('VSL Cloudflare Stream adapter boundary', () => {
  it('accepts empty successful delete responses without parsing JSON', async () => {
    const network = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(new CloudflareStreamAdapter(config, network).deleteVideo(id)).resolves.toBeUndefined();
  });
  it('creates Direct Creator TUS, uses official ID header and never parses Location ID', async () => {
    const network = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 201,
        headers: {
          location: 'https://upload.videodelivery.net/not-the-video-id',
          'stream-media-id': id,
        },
      })
    );
    const adapter = new CloudflareStreamAdapter(config, network);
    expect(
      await adapter.createResumableUpload({
        id: intent,
        bytes: 1024,
        expiresAt: '2026-09-28T12:00:00Z',
      })
    ).toMatchObject({ providerId: id });
    const [url, request] = network.mock.calls[0];
    expect(url).toContain('?direct_user=true');
    expect(request.headers['Upload-Creator']).toBe(`vsl-${intent}`);
    expect(request.headers['Upload-Metadata']).toContain(
      `maxDurationSeconds ${Buffer.from('7200').toString('base64')}`
    );
    expect(request.headers['Upload-Length']).toBe('1024');
    expect(request.body).toBeUndefined();
  });
  it('rejects limits before networking and treats missing identity/lost response as uncertain without retry', async () => {
    const network = vi
      .fn()
      .mockRejectedValue(new Error('Bearer sensitive https://upload.videodelivery.net/private'));
    const adapter = new CloudflareStreamAdapter(config, network);
    await expect(
      adapter.createResumableUpload({ id: intent, bytes: VIDEO_LIMITS.bytes + 1, expiresAt: '' })
    ).rejects.toThrow('5 GB');
    expect(network).not.toHaveBeenCalled();
    await expect(
      adapter.createResumableUpload({ id: intent, bytes: 1, expiresAt: '2026-09-28T12:00:00Z' })
    ).rejects.toThrow('outcome uncertain');
    expect(network).toHaveBeenCalledTimes(1);
    const bad = new CloudflareStreamAdapter(
      config,
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 201,
          headers: { location: `https://upload.videodelivery.net/${id}` },
        })
      )
    );
    await expect(
      bad.createResumableUpload({ id: intent, bytes: 1, expiresAt: '' })
    ).rejects.toThrow('identity missing');
  });
  it('queries exact creator and validates status/metadatasafe projection', async () => {
    const network = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, result: [meta] }))
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { ...meta, secret: 'must-not-surface' } })
      );
    const adapter = new CloudflareStreamAdapter(config, network);
    expect(await adapter.findByIntent(intent)).toHaveLength(1);
    expect(network.mock.calls[0]![0]).toContain(`creator=vsl-${intent}`);
    const result = await adapter.getVideoStatus(id);
    expect(result).toMatchObject({ ready: true, duration: 60 });
    expect(result).not.toHaveProperty('secret');
  });
  it('reports provider origins as-is; the union policy decides (no 409 after publish adds a host)', async () => {
    const network = vi
      .fn()
      .mockResolvedValue(
        Response.json({ success: true, result: { ...meta, allowedOrigins: [...config.allowedOrigins, 'offer.example.com'] } })
      );
    const result = await new CloudflareStreamAdapter(config, network).getVideoStatus(id);
    expect(result?.allowedOrigins).toEqual([...config.allowedOrigins, 'offer.example.com']);
    expect(streamOriginsAllowed(['*'], ['*.vsl-preview.test'])).toBe(false);
    expect(streamOriginsAllowed([], ['*.vsl-preview.test'])).toBe(false);
    expect(streamOriginsAllowed(['a.vsl-preview.test', 'offer.example.com'], ['*.vsl-preview.test', 'offer.example.com'])).toBe(true);
    expect(streamOriginsAllowed(['evil.example.com'], ['*.vsl-preview.test', 'offer.example.com'])).toBe(false);
  });
  it('validates raw HMAC bytes, timestamp and tampering', () => {
    const raw = Buffer.from('{"uid":"fixture"}\n'),
      now = 1800000000;
    const sign = (time: number, body = raw) =>
      `time=${time},sig1=${createHmac('sha256', config.webhookSecret).update(`${time}.`).update(body).digest('hex')}`;
    expect(verifyStreamWebhook(raw, sign(now), config.webhookSecret, now)).toBe(true);
    expect(
      verifyStreamWebhook(Buffer.from('{"uid":"fixture"}'), sign(now), config.webhookSecret, now)
    ).toBe(false);
    expect(verifyStreamWebhook(raw, sign(now - 301), config.webhookSecret, now)).toBe(false);
    expect(verifyStreamWebhook(raw, sign(now + 301), config.webhookSecret, now)).toBe(false);
    expect(verifyStreamWebhook(raw, 'time=1,sig1=bad', config.webhookSecret, now)).toBe(false);
  });
  it('creates official playback only, requires config and scopes CSP without global wildcard', () => {
    const descriptor = streamPlaybackDescriptor(id, config.customerHost);
    expect(descriptor.sdkUrl).toBe(STREAM_SDK);
    expect(descriptor.events).toContain('waiting');
    expect(descriptor.signed).toBe(false);
    expect(() => streamConfig({})).toThrow();
    expect(() => validateUploadUrl('https://evil.test/upload')).toThrow();
    const p = previewConfig({
      NODE_ENV: 'test',
      VSL_PREVIEW_TOKEN_SECRET: 'unit-only-long-secret-1234567890123456',
      VSL_PREVIEW_DOMAIN: 'vsl-preview.test',
      VSL_PREVIEW_FRAME_ORIGIN: 'https://admin.test',
    });
    const headers = previewHeaders(p, 'text/html', config.customerHost);
    expect(headers['content-security-policy']).toContain(
      `frame-src https://${config.customerHost}`
    );
    expect(headers['content-security-policy']).toContain('https://embed.cloudflarestream.com');
    expect(headers['content-security-policy']).not.toContain('https://*');
    expect(previewHeaders(p, 'text/html')['content-security-policy']).toContain("frame-src 'none'");
    expect(() => previewHeaders(p, 'text/html', 'evil.test')).toThrow();
  });
  it('treats delete 404 as confirmation and redacts provider failures', async () => {
    const adapter = new CloudflareStreamAdapter(
      config,
      vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    );
    await adapter.deleteVideo(id);
    const error = new CloudflareStreamAdapter(
      config,
      vi.fn().mockResolvedValue(Response.json({ secret: config.apiToken }, { status: 500 }))
    );
    await expect(error.getVideoStatus(id)).rejects.toThrow('operation unavailable');
  });
});
