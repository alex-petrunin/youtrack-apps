/**
 * Webhook delivery via async function chain.
 *
 * Sync action dispatches webhook 1 via postAsync; the response handler
 * `logAndPostNext` logs the result and dispatches webhook 2 via another postAsync,
 * and so on. Each webhook costs one async hop. Server `maxChainLength = 10` by
 * default, giving the practical cap in {@link MAX_WEBHOOK_URLS_PER_EVENT}.
 *
 * Each webhook carries its OWN signing token (configured per endpoint in the
 * settings widget), so the token travels through the chain state alongside the
 * URL. The shared `headerName` setting names the header the token is sent in.
 */

const http = require('@jetbrains/youtrack-scripting-api/http');
const security = require('./workflow-security');

const WEBHOOK_TIMEOUT_MS = 5000;
const MAX_WEBHOOK_URLS_PER_EVENT = 10;
const ALL_EVENTS_TYPE = 'allEvents';

const STORE_ENTRIES = 'webhookEntries';
const STORE_PAYLOAD = 'webhookPayload';
const STORE_EVENT = 'webhookEvent';
const STORE_CURRENT_URL = 'webhookCurrentUrl';

/**
 * Parses the structured webhook list from project settings.
 * @param {Object} ctx - The workflow context with settings
 * @returns {Array<{url: string, token: string, events: Array<string>}>} Parsed webhooks (best-effort)
 */
function parseWebhooks(ctx) {
  const raw = ctx.settings.webhooksJson;
  if (!raw || typeof raw !== 'string') {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('[webhooks] Could not parse webhooksJson setting: ' + (error.message || error));
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(function (w) {
    return w && typeof w.url === 'string';
  });
}

/**
 * Returns the deduplicated endpoints subscribed to the given event type.
 * A webhook subscribes to an event when its `events` array contains the event
 * type or the catch-all `allEvents`. Deduplicated by URL (first token wins).
 * @param {Object} ctx - The workflow context with settings
 * @param {string} eventType - Event type identifier (e.g. 'issueCreated')
 * @returns {Array<{url: string, token: string}>} Endpoints for this event
 */
function getWebhooksForEvent(ctx, eventType) {
  const webhooks = parseWebhooks(ctx);
  const seen = {};
  const result = [];

  webhooks.forEach(function (w) {
    const events = Array.isArray(w.events) ? w.events : [];
    const subscribed = events.indexOf(eventType) !== -1 || events.indexOf(ALL_EVENTS_TYPE) !== -1;
    if (!subscribed) {
      return;
    }
    const url = (w.url || '').trim();
    if (!url || seen[url]) {
      return;
    }
    seen[url] = true;
    result.push({url: url, token: typeof w.token === 'string' ? w.token : ''});
  });

  return result;
}

/**
 * Logs the outcome of a single webhook delivery.
 * @param {Object} response - ctx.response from the postAsync handler
 * @param {string} url - The webhook URL that was hit
 */
function logWebhookResponse(response, url) {
  if (!response) {
    console.warn('[webhooks] No response object received for ' + url);
    return;
  }
  if (response.exception) {
    console.error('[webhooks] Webhook to ' + url + ' failed: ' + response.exception);
    return;
  }
  if (!response.code) {
    console.warn('[webhooks] Webhook request to ' + url + ' completed but returned no status code (likely timeout after ' + WEBHOOK_TIMEOUT_MS + 'ms)');
    return;
  }

  console.log('[webhooks] Webhook sent successfully to ' + url);
  console.log('[webhooks] Response code: ' + response.code);
  // Response body not logged — SSRF: receivers may reflect internal data.
}

/**
 * Validates an endpoint, persists post-dispatch state, then fires postAsync with
 * `logAndPostNext` as the response handler. Stores BEFORE scheduling per the
 * async-functions "store before invoke" guidance. Fails closed: an endpoint with
 * no token is skipped rather than sent unauthenticated.
 * @param {{url: string, token: string}} entry - The endpoint to dispatch
 * @returns {boolean} true on scheduled, false on rejection (caller may try the next).
 */
function tryPostWebhook(ctx, entry, remaining, headerName, payloadJson) {
  const url = entry.url;
  const validation = security.validateWebhookUrl(url);
  if (!validation.valid) {
    console.error('[webhooks] Blocked webhook to ' + url + ': ' + validation.reason);
    return false;
  }

  if (!entry.token) {
    console.warn('[webhooks] No token configured for ' + url + ' — skipping (fail closed)');
    return false;
  }

  if (url.startsWith('http://')) {
    console.warn('[webhooks] Warning: webhook URL uses HTTP (not HTTPS) — the webhook token will be transmitted in plaintext. HTTPS is strongly recommended: ' + url);
  }

  ctx.store(STORE_ENTRIES, JSON.stringify(remaining));
  ctx.store(STORE_CURRENT_URL, url);

  try {
    const connection = new http.Connection(url, null, WEBHOOK_TIMEOUT_MS);
    connection.addHeader('Content-Type', 'application/json');
    security.addSecurityHeaders(connection, entry.token, headerName);
    connection.postAsync('', '', payloadJson, 'logAndPostNext');
    return true;
  } catch (error) {
    const errorMessage = error.message || error.toString() || 'Unknown error';
    console.error('[webhooks] Failed to schedule webhook to ' + url + ': ' + errorMessage);
    return false;
  }
}

/**
 * Dispatches the next valid endpoint via postAsync. Invalid or token-less
 * endpoints are skipped synchronously without consuming an async hop.
 * @returns {boolean} true if scheduled, false if no valid endpoints remain.
 */
function postNextValid(ctx) {
  const headerName = ctx.settings.headerName;

  // Fail closed if the header name was cleared mid-chain.
  if (!headerName) {
    console.warn('[webhooks] Header name was cleared during chain execution; aborting remaining dispatches');
    return false;
  }

  const payloadJson = ctx.load(STORE_PAYLOAD);
  const entriesJson = ctx.load(STORE_ENTRIES);
  const entries = entriesJson ? JSON.parse(entriesJson) : [];

  while (entries.length > 0) {
    const entry = entries.shift();
    if (tryPostWebhook(ctx, entry, entries, headerName, payloadJson)) {
      return true;
    }
  }

  ctx.store(STORE_ENTRIES, JSON.stringify(entries));
  return false;
}

/**
 * Response handler for each postAsync. Logs the previous response and
 * dispatches the next endpoint.
 */
function logAndPostNext(ctx) {
  const url = ctx.load(STORE_CURRENT_URL);
  logWebhookResponse(ctx.response, url);
  postNextValid(ctx);
}

/**
 * Schedules webhooks for an event via the async function chain. Call from a
 * rule's sync `action`. The rule must declare `asyncFunctions: core.asyncFunctions`.
 * @param {Object} ctx - The workflow context with settings
 * @param {string} eventType - Event type identifier (e.g. 'issueCreated')
 * @param {Object} payload - Webhook payload
 * @param {string} eventName - Human-readable event name for logging
 */
function sendWebhooks(ctx, eventType, payload, eventName) {
  const headerName = ctx.settings.headerName || null;
  if (!headerName) {
    console.warn('[webhooks] No header name configured - webhooks disabled for ' + eventName);
    return;
  }

  const allEntries = getWebhooksForEvent(ctx, eventType);

  if (allEntries.length === 0) {
    console.log('[webhooks] No webhook endpoints subscribed to ' + eventName);
    return;
  }

  // Filter invalid URLs and token-less endpoints first so the cap applies to
  // endpoints that can actually be dispatched.
  const validEntries = allEntries.filter(function (entry) {
    const validation = security.validateWebhookUrl(entry.url);
    if (!validation.valid) {
      console.error('[webhooks] Blocked webhook to ' + entry.url + ': ' + validation.reason);
      return false;
    }
    if (!entry.token) {
      console.warn('[webhooks] No token configured for ' + entry.url + ' — skipping (fail closed)');
      return false;
    }
    return true;
  });

  if (validEntries.length === 0) {
    console.log('[webhooks] No valid webhook endpoints for ' + eventName);
    return;
  }

  let entries = validEntries;
  if (validEntries.length > MAX_WEBHOOK_URLS_PER_EVENT) {
    console.warn('[webhooks] ' + validEntries.length + ' valid endpoints configured for ' + eventName + ' but max is ' + MAX_WEBHOOK_URLS_PER_EVENT + ' per event (async chain limit). Extra endpoints dropped.');
    entries = validEntries.slice(0, MAX_WEBHOOK_URLS_PER_EVENT);
  }

  ctx.store(STORE_ENTRIES, JSON.stringify(entries));
  ctx.store(STORE_PAYLOAD, JSON.stringify(payload));
  ctx.store(STORE_EVENT, eventName);

  console.log('[webhooks] Scheduling ' + entries.length + ' webhook(s) for ' + eventName);
  postNextValid(ctx);
}

const asyncFunctions = {
  logAndPostNext: logAndPostNext,
};

exports.parseWebhooks = parseWebhooks;
exports.getWebhooksForEvent = getWebhooksForEvent;
exports.sendWebhooks = sendWebhooks;
exports.logAndPostNext = logAndPostNext;
exports.logWebhookResponse = logWebhookResponse;
exports.postNextValid = postNextValid;
exports.asyncFunctions = asyncFunctions;
exports.ALL_EVENTS_TYPE = ALL_EVENTS_TYPE;
exports.MAX_WEBHOOK_URLS_PER_EVENT = MAX_WEBHOOK_URLS_PER_EVENT;
exports.WEBHOOK_TIMEOUT_MS = WEBHOOK_TIMEOUT_MS;