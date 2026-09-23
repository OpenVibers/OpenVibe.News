'use strict';

/**
 * News → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   news.source.ingested                 a Sources item was ingested (created, revised or removed
 *                                        upstream), with its dedupe and cluster outcome
 *   news.source.failed                   ingestion failed: Sources reported a failed fetch of a news
 *                                        source, or News could not read an item (no story text is
 *                                        ever made in its place)
 *   news.cluster.updated                 a cluster was created, grew, merged, split or a merge/split
 *                                        was reversed
 *   news.story.created|flagged           internal editorial events
 *   news.story.published|updated|unpublished|retracted
 *                                        publication changes (canonical URL, state, indexability; no
 *                                        body; public only for public, listable stories)
 *   news.index_document.upserted|deleted the OpenVibe.Search document or tombstone (index-hooks)
 *
 * emit() runs inside the SQLite transaction that makes the change, so an event exists if and only
 * if its change committed. The relay publishes with News' service token (events.event.publish,
 * audience openvibe.events) only when EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise
 * rows wait in event_outbox and /api/ready reports the relay as off.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

function createNewsOutbox({ db, config, fetchImpl, now, log = console }) {
    const enabled = Boolean(config.events.url && config.oauth.clientSecret);
    const clientOpts = { baseUrls: { events: config.events.url || 'http://127.0.0.1:4300' }, retries: 0 };
    if (fetchImpl) clientOpts.fetch = fetchImpl;
    if (enabled) {
        clientOpts.tokenProvider = createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            scope: { 'openvibe.events': 'events.event.publish' }, ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
    } else {
        clientOpts.getToken = async () => { throw new Error('events relay disabled (EVENTS_URL / OV_OAUTH_CLIENT_SECRET unset)'); };
    }
    const events = createEventsClient(createClient(clientOpts), { source: 'news' });
    let lastError = null;
    const outbox = createOutbox(db, {
        events,
        intervalMs: config.events.intervalMs,
        now,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) log.warn('[News] event publish failed (will retry):', msg);
            lastError = msg;
        },
    });
    outbox.ensureSchema();

    /** Inside the caller's transaction. Returns the complete envelope (with its event_id). */
    function emit(envelope, { traceparent } = {}) {
        return outbox.enqueue(envelope, { traceparent });
    }

    return {
        emit,
        outbox,
        enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        kick() { if (enabled) outbox.kick(); },
        status: () => ({ enabled, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createNewsOutbox };
