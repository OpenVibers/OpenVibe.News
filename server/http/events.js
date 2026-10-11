'use strict';

/**
 * Events consumer: POST /internal/events, the endpoint of News' OpenVibe.Events subscriptions
 * (topic patterns `sources.item.*` and `sources.fetch.failed`, see scripts/subscribe.js).
 *
 *   sources.item.created|updated   the item is read from Sources (sources.item.read) and applied
 *   sources.item.removed           applied from the payload (the removal is sticky)
 *   sources.fetch.failed           recorded; relayed as news.source.failed; no text is made
 *
 * The signature (X-OpenVibe-Signature v2, ±300 s) and the exactly-once inbox come from the chassis
 * (openvibe-publishing/ingest.createEventConsumer): the receipt (consumer, event_id) and the change
 * commit in one PostgreSQL transaction, so a redelivery changes nothing. When Sources cannot be read,
 * the delivery is answered 503 so Events retries it, and the failure is recorded (and relayed as
 * news.source.failed on the first attempt). The cursor pull catches anything that never arrives.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { createEventConsumer } = require('openvibe-publishing/ingest');

const CONSUMER = 'news-sources';
const EVT_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;

function createEvents({ config, store, ingest, sources, log = console }) {
    const router = express.Router();
    const consumer = createEventConsumer({ db: store.db, secrets: config.events.webhookSecrets, consumer: CONSUMER, now: store.now });
    const { inbox, verify } = consumer;

    router.post('/internal/events', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        const ctx = req.ov;
        res.set('Cache-Control', 'no-store');
        if (!config.events.webhookSecrets.length) return http.sendProblem(res, 503, 'news.webhook_disabled', { detail: 'NEWS_EVENTS_SECRET is not set', ctx });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        // v2 only: signature over "<t>.<raw body>" and t within ±300 s (a replayed or v1-only delivery fails).
        const delivery = verify(raw, req.headers);
        if (!delivery) return http.sendProblem(res, 401, 'news.bad_signature', { detail: 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window', ctx });
        const event = delivery.event;
        if (!event || typeof event.event_id !== 'string' || !EVT_RE.test(event.event_id)) {
            return http.sendProblem(res, 400, 'news.bad_delivery', { detail: 'body must be { event: <envelope> }', ctx });
        }
        const attempt = Number(req.get('x-openvibe-delivery-attempt')) || 1;
        const type = String(event.event_type || '');
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const fromSources = event.source === 'sources';

        try {
            if (!fromSources || !/^sources\.(item\.(created|updated|removed)|fetch\.failed)$/.test(type)) {
                await inbox.once(CONSUMER, event.event_id, () => null);
                return res.status(204).end();
            }
            if (type === 'sources.item.removed') {
                await inbox.once(CONSUMER, event.event_id, async () => {
                    const r = await ingest.applyRemoval({ sourcesItemId: String(p.item_id || ''), reason: p.reason, revision: Number.isInteger(p.revision) ? p.revision : null, origin: 'webhook' });
                    await ingest.recordRun({ origin: 'webhook', state: r.outcome, source_key: p.source_key || null, sources_item_id: p.item_id || null });
                    return r;
                });
                return res.status(204).end();
            }
            if (type === 'sources.fetch.failed') {
                await inbox.once(CONSUMER, event.event_id, () => ingest.upstreamFailure(p));
                return res.status(204).end();
            }
            // created | updated
            if (p.category && p.category !== config.sources.category) {
                await inbox.once(CONSUMER, event.event_id, () => null);
                return res.status(204).end();
            }
            let fetched;
            try {
                if (p.source_key) await ingest.learnOutlets([String(p.source_key)]);
                fetched = await sources.getItem(String(p.item_id || ''));
            } catch (err) {
                await store.tx(async () => {
                    await ingest.recordRun({ origin: 'webhook', state: 'failed', source_key: p.source_key || null, sources_item_id: p.item_id || null, error_code: err.code || 'sources.error', detail: `${type} ${event.event_id} attempt ${attempt}: ${err.message}` });
                    if (attempt === 1) await ingest.failedEvent({ origin: 'webhook', sourceKey: p.source_key || null, sourcesItemId: p.item_id || null, state: 'failed', errorCode: err.code || 'sources.error', detail: err.message, httpStatus: err.status || null });
                });
                if (err.status === 404) {
                    // Sources no longer has it: nothing to apply, and retrying cannot help.
                    await inbox.once(CONSUMER, event.event_id, () => null);
                    return res.status(204).end();
                }
                return http.sendProblem(res, 503, 'news.sources_unavailable', { detail: 'OpenVibe.Sources could not be read; retry later', ctx });
            }
            if (fetched.source) await ingest.rememberSources({ [fetched.item.source_key]: fetched.source });
            await inbox.once(CONSUMER, event.event_id, async () => {
                const r = await ingest.apply(fetched.item, { origin: 'webhook' });
                await ingest.recordRun({ origin: 'webhook', state: r.outcome, source_key: fetched.item.source_key || null, sources_item_id: fetched.item.id, detail: r.reason || null });
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

module.exports = { createEvents, CONSUMER };
