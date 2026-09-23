'use strict';

/**
 * Events consumer: POST /internal/events, the endpoint of News' OpenVibe.Events subscriptions
 * (topic patterns `sources.item.*` and `sources.fetch.failed`, see scripts/subscribe.js).
 *
 *   sources.item.created|updated   the item is read from Sources (sources.item.read) and applied
 *   sources.item.removed           applied from the payload (the removal is sticky)
 *   sources.fetch.failed           recorded; relayed as news.source.failed; no text is made
 *
 * Deliveries are verified with X-OpenVibe-Signature against NEWS_EVENTS_SECRET (comma-separated
 * during rotation). Exactly once: the inbox receipt (consumer, event_id) and the change commit in
 * one SQLite transaction; a redelivery is answered 204 and changes nothing. When Sources cannot be
 * read, the delivery is answered 503 so Events retries it, and the failure is recorded (and relayed
 * as news.source.failed on the first attempt). The cursor pull catches anything that never arrives.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { verifyDeliveryV2, createInbox } = require('openvibe-sdk/events');

const CONSUMER = 'news-sources';
const EVT_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;

function createWebhook({ config, store, ingest, sources, log = console }) {
    const router = express.Router();
    const inbox = createInbox(store.db, { now: store.now });
    inbox.ensureSchema();

    router.post('/internal/events', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        const ctx = req.ov;
        res.set('Cache-Control', 'no-store');
        const secrets = config.events.webhookSecrets;
        if (!secrets.length) return http.sendProblem(res, 503, 'news.webhook_disabled', { detail: 'NEWS_EVENTS_SECRET is not set', ctx });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        // v2 only: signature over "<t>.<raw body>" and t within ±300 s (a replayed or v1-only delivery fails).
        if (!secrets.some((s) => verifyDeliveryV2(raw, req.headers, s))) return http.sendProblem(res, 401, 'news.bad_signature', { detail: 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window', ctx });
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
        const event = body && body.event;
        if (!event || typeof event.event_id !== 'string' || !EVT_RE.test(event.event_id)) {
            return http.sendProblem(res, 400, 'news.bad_delivery', { detail: 'body must be { event: <envelope>, seq }', ctx });
        }
        const attempt = Number(req.get('x-openvibe-delivery-attempt')) || 1;
        const type = String(event.event_type || '');
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const fromSources = event.source === 'sources';

        try {
            if (!fromSources || !/^sources\.(item\.(created|updated|removed)|fetch\.failed)$/.test(type)) {
                inbox.once(CONSUMER, event.event_id, () => null);
                return res.status(204).end();
            }
            if (type === 'sources.item.removed') {
                inbox.once(CONSUMER, event.event_id, () => {
                    const r = ingest.applyRemoval({ sourcesItemId: String(p.item_id || ''), reason: p.reason, revision: Number.isInteger(p.revision) ? p.revision : null, origin: 'webhook' });
                    ingest.recordRun({ origin: 'webhook', state: r.outcome, source_key: p.source_key || null, sources_item_id: p.item_id || null });
                    return r;
                });
                return res.status(204).end();
            }
            if (type === 'sources.fetch.failed') {
                inbox.once(CONSUMER, event.event_id, () => ingest.upstreamFailure(p));
                return res.status(204).end();
            }
            // created | updated
            if (p.category && p.category !== config.sources.category) {
                inbox.once(CONSUMER, event.event_id, () => null);
                return res.status(204).end();
            }
            let fetched;
            try {
                if (p.source_key) await ingest.learnOutlets([String(p.source_key)]);
                fetched = await sources.getItem(String(p.item_id || ''));
            } catch (err) {
                store.tx(() => {
                    ingest.recordRun({ origin: 'webhook', state: 'failed', source_key: p.source_key || null, sources_item_id: p.item_id || null, error_code: err.code || 'sources.error', detail: `${type} ${event.event_id} attempt ${attempt}: ${err.message}` });
                    if (attempt === 1) ingest.failedEvent({ origin: 'webhook', sourceKey: p.source_key || null, sourcesItemId: p.item_id || null, state: 'failed', errorCode: err.code || 'sources.error', detail: err.message, httpStatus: err.status || null });
                });
                if (err.status === 404) {
                    // Sources no longer has it: nothing to apply, and retrying cannot help.
                    inbox.once(CONSUMER, event.event_id, () => null);
                    return res.status(204).end();
                }
                return http.sendProblem(res, 503, 'news.sources_unavailable', { detail: 'OpenVibe.Sources could not be read; retry later', ctx });
            }
            if (fetched.source) ingest.rememberSources({ [fetched.item.source_key]: fetched.source });
            inbox.once(CONSUMER, event.event_id, () => {
                const r = ingest.apply(fetched.item, { origin: 'webhook' });
                ingest.recordRun({ origin: 'webhook', state: r.outcome, source_key: fetched.item.source_key || null, sources_item_id: fetched.item.id, detail: r.reason || null });
                return r;
            });
            return res.status(204).end();
        } catch (err) {
            log.error('[News] webhook failed:', err && err.stack ? err.stack : err);
            return http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx });
        }
    });

    return router;
}

module.exports = { createWebhook, CONSUMER };
