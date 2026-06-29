import { describe, it, expect, vi, beforeEach } from 'vitest';
// @jetbrains/youtrack-scripting-api/http is stubbed by setup.js via
// Module._resolveFilename so workflow-http.js loads without YouTrack runtime.
import {
  parseWebhooks,
  getWebhooksForEvent,
  sendWebhooks,
  logAndPostNext,
  asyncFunctions,
  MAX_WEBHOOK_URLS_PER_EVENT,
} from '../workflow-http.js';
import { createCtx } from './helpers/ctx.js';
// Reach into the CJS stub to inspect Connection instances.
import httpStub from './mocks/youtrack-http.cjs';

const { instances: httpInstances, reset: resetHttp } = httpStub;

const HEADER = 'X-Token';
const PAYLOAD = { event: 'test' };

// Stand-in for the backend's masked secret-map host object: get(id) returns the real token.
function makeSecretMap(map) {
  return {
    get(id) {
      return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
    },
  };
}

// Builds a ctx whose project settings hold a structured webhook list. Test fixtures still pass each
// endpoint's token inline as { url, token, events }; this helper assigns a stable id per entry, then
// splits the data the way the new schema stores it: non-secret { id, url, events } in webhooksJson and
// the tokens in the write-only webhookSecrets map (empty tokens are omitted, as the widget would).
function ctxWith(webhooks, { headerName = HEADER } = {}) {
  const withIds = webhooks.map((w, i) => ({ id: w.id != null ? w.id : 'wh-' + i, ...w }));
  const secrets = {};
  withIds.forEach(w => {
    if (typeof w.token === 'string' && w.token !== '') {
      secrets[w.id] = w.token;
    }
  });
  const meta = withIds.map(({ id, url, events }) => ({ id, url, events }));
  return createCtx({
    settings: {
      headerName,
      webhooksJson: JSON.stringify(meta),
      webhookSecrets: makeSecretMap(secrets),
    },
    asyncFunctions,
  });
}

// ── parseWebhooks ─────────────────────────────────────────────────────────────

describe('parseWebhooks', () => {
  it('returns [] when the setting is missing', () => {
    expect(parseWebhooks(createCtx({ settings: {} }))).toEqual([]);
  });

  it('returns [] for invalid JSON', () => {
    expect(parseWebhooks(createCtx({ settings: { webhooksJson: 'not json' } }))).toEqual([]);
  });

  it('returns [] when the JSON is not an array', () => {
    expect(parseWebhooks(createCtx({ settings: { webhooksJson: '{}' } }))).toEqual([]);
  });

  it('drops entries without a string url', () => {
    const ctx = createCtx({
      settings: { webhooksJson: JSON.stringify([{ url: 'https://a.com/' }, { token: 'x' }, null]) },
    });
    expect(parseWebhooks(ctx)).toEqual([{ url: 'https://a.com/' }]);
  });
});

// ── getWebhooksForEvent ───────────────────────────────────────────────────────

describe('getWebhooksForEvent', () => {
  it('returns only endpoints subscribed to the event type', () => {
    const ctx = ctxWith([
      { url: 'https://a.com/', token: 'ta', events: ['issueCreated'] },
      { url: 'https://b.com/', token: 'tb', events: ['issueUpdated'] },
    ]);
    expect(getWebhooksForEvent(ctx, 'issueCreated')).toEqual([{ id: 'wh-0', url: 'https://a.com/' }]);
  });

  it('includes endpoints subscribed to allEvents', () => {
    const ctx = ctxWith([
      { url: 'https://a.com/', token: 'ta', events: ['issueUpdated'] },
      { url: 'https://b.com/', token: 'tb', events: ['allEvents'] },
    ]);
    expect(getWebhooksForEvent(ctx, 'issueCreated')).toEqual([{ id: 'wh-1', url: 'https://b.com/' }]);
  });

  it('deduplicates by URL, first id wins', () => {
    const ctx = ctxWith([
      { url: 'https://a.com/', token: 'first', events: ['issueCreated'] },
      { url: 'https://a.com/', token: 'second', events: ['allEvents'] },
    ]);
    expect(getWebhooksForEvent(ctx, 'issueCreated')).toEqual([{ id: 'wh-0', url: 'https://a.com/' }]);
  });

  it('returns each subscribed endpoint with its id', () => {
    const ctx = ctxWith([
      { url: 'https://a.com/', token: 'ta', events: ['issueCreated'] },
      { url: 'https://b.com/', token: 'tb', events: ['issueCreated'] },
    ]);
    expect(getWebhooksForEvent(ctx, 'issueCreated')).toEqual([
      { id: 'wh-0', url: 'https://a.com/' },
      { id: 'wh-1', url: 'https://b.com/' },
    ]);
  });
});

// ── sendWebhooks scheduling ───────────────────────────────────────────────────

describe('sendWebhooks scheduling', () => {
  beforeEach(() => {
    resetHttp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('dispatches endpoint #1 with ITS OWN token via postAsync', () => {
    const ctx = ctxWith([
      { url: 'https://a.com/', token: 'token-a', events: ['issueCreated'] },
      { url: 'https://b.com/', token: 'token-b', events: ['issueCreated'] },
    ]);
    sendWebhooks(ctx, 'issueCreated', PAYLOAD, 'IssueCreated');

    expect(httpInstances).toHaveLength(1);
    const conn = httpInstances[0];
    expect(conn.url).toBe('https://a.com/');
    expect(conn.headers[HEADER]).toBe('token-a');
    expect(conn.calls[0].method).toBe('postAsync');
    expect(conn.calls[0].handlerName).toBe('logAndPostNext');
    expect(conn.calls[0].payload).toBe(JSON.stringify(PAYLOAD));
  });

  it('stores remaining {id, url} entries (no token), payload, and current URL', () => {
    const ctx = ctxWith([
      { url: 'https://a.com/', token: 'token-a', events: ['issueCreated'] },
      { url: 'https://b.com/', token: 'token-b', events: ['issueCreated'] },
    ]);
    sendWebhooks(ctx, 'issueCreated', PAYLOAD, 'IssueCreated');

    expect(JSON.parse(ctx._storeMap.get('webhookEntries'))).toEqual([
      { id: 'wh-1', url: 'https://b.com/' },
    ]);
    expect(ctx._storeMap.get('webhookCurrentUrl')).toBe('https://a.com/');
    expect(JSON.parse(ctx._storeMap.get('webhookPayload'))).toEqual(PAYLOAD);
  });

  it('does not dispatch when no endpoint is subscribed', () => {
    const ctx = ctxWith([{ url: 'https://a.com/', token: 't', events: ['issueUpdated'] }]);
    sendWebhooks(ctx, 'issueCreated', PAYLOAD, 'IssueCreated');
    expect(httpInstances).toHaveLength(0);
  });

  it('does not dispatch when the header name is missing', () => {
    const ctx = ctxWith([{ url: 'https://a.com/', token: 't', events: ['issueCreated'] }], { headerName: '' });
    sendWebhooks(ctx, 'issueCreated', PAYLOAD, 'IssueCreated');
    expect(httpInstances).toHaveLength(0);
  });

  it('skips a token-less endpoint (fail closed) and dispatches the next', () => {
    const ctx = ctxWith([
      { url: 'https://a.com/', token: '', events: ['issueCreated'] },
      { url: 'https://b.com/', token: 'token-b', events: ['issueCreated'] },
    ]);
    sendWebhooks(ctx, 'issueCreated', PAYLOAD, 'IssueCreated');
    expect(httpInstances).toHaveLength(1);
    expect(httpInstances[0].url).toBe('https://b.com/');
  });

  it('skips an invalid first URL synchronously and dispatches the next valid one', () => {
    const ctx = ctxWith([
      { url: 'http://10.0.0.1/', token: 'ta', events: ['issueCreated'] },
      { url: 'https://b.com/', token: 'tb', events: ['issueCreated'] },
    ]);
    sendWebhooks(ctx, 'issueCreated', PAYLOAD, 'IssueCreated');
    expect(httpInstances).toHaveLength(1);
    expect(httpInstances[0].url).toBe('https://b.com/');
  });

  it('caps endpoints at MAX_WEBHOOK_URLS_PER_EVENT and warns', () => {
    const webhooks = [];
    for (let i = 0; i < MAX_WEBHOOK_URLS_PER_EVENT + 3; i++) {
      webhooks.push({ url: 'https://host' + i + '.example.com/', token: 't' + i, events: ['issueCreated'] });
    }
    const ctx = ctxWith(webhooks);
    sendWebhooks(ctx, 'issueCreated', PAYLOAD, 'IssueCreated');

    const stored = JSON.parse(ctx._storeMap.get('webhookEntries'));
    expect(stored).toHaveLength(MAX_WEBHOOK_URLS_PER_EVENT - 1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('max is ' + MAX_WEBHOOK_URLS_PER_EVENT));
  });
});

// ── chain progression with per-URL tokens ────────────────────────────────────

describe('chain progression', () => {
  beforeEach(() => {
    resetHttp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('walks a 2-endpoint chain, each sent with its own token', () => {
    const ctx = ctxWith([
      { url: 'https://a.com/', token: 'token-a', events: ['issueCreated'] },
      { url: 'https://b.com/', token: 'token-b', events: ['issueCreated'] },
    ]);

    sendWebhooks(ctx, 'issueCreated', PAYLOAD, 'IssueCreated');
    expect(httpInstances).toHaveLength(1);
    expect(httpInstances[0].headers[HEADER]).toBe('token-a');

    ctx.response = { code: 200 };
    logAndPostNext(ctx);
    expect(httpInstances).toHaveLength(2);
    expect(httpInstances[1].url).toBe('https://b.com/');
    expect(httpInstances[1].headers[HEADER]).toBe('token-b');

    ctx.response = { code: 200 };
    logAndPostNext(ctx);
    expect(httpInstances).toHaveLength(2);
  });
});

// ── fail-closed: header cleared mid-chain ─────────────────────────────────────

describe('settings-disappear-mid-chain guard', () => {
  beforeEach(() => {
    resetHttp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('aborts the chain when the header name is cleared between hops', () => {
    const ctx = ctxWith([
      { url: 'https://a.com/', token: 'token-a', events: ['issueCreated'] },
      { url: 'https://b.com/', token: 'token-b', events: ['issueCreated'] },
    ]);

    sendWebhooks(ctx, 'issueCreated', PAYLOAD, 'IssueCreated');
    expect(httpInstances).toHaveLength(1);

    ctx.settings.headerName = null;

    ctx.response = { code: 200 };
    logAndPostNext(ctx);

    expect(httpInstances).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Header name was cleared during chain execution'),
    );
  });
});

// ── asyncFunctions export ─────────────────────────────────────────────────────

describe('asyncFunctions export', () => {
  it('exposes logAndPostNext', () => {
    expect(typeof asyncFunctions.logAndPostNext).toBe('function');
    expect(asyncFunctions.logAndPostNext).toBe(logAndPostNext);
  });
});