'use strict';
/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 *   db              required  a real query on News' SQLite (the nine charter tables answer)
 *   network_jwks    optional  the Network signing key has loaded; without it pages and feeds still
 *                             serve, but nobody can sign in and service tokens are refused (503)
 *   events_relay    optional  the outbox relay is configured and has no rejected rows; when it is
 *                             off, events wait in event_outbox (Search and subscribers lag)
 *   events_webhook  optional  NEWS_EVENTS_SECRET is set, so Events can deliver sources.item.*
 *   sources_pull    optional  the last cursor pull from OpenVibe.Sources succeeded (or pulls are
 *                             off); a failing pull means new source items are not arriving
 *
 * Request metrics come from openvibe-shared/metrics in app.js; content counts are not metrics.
 */
const { createReadiness } = require('openvibe-shared/ready');
const { CHARTER_TABLES } = require('./db');

function createNewsReadiness({ store, auth, outbox, ingest, config, release = null }) {
    const { db } = store;
    return createReadiness({
        service: 'news',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: () => {
                    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name));
                    const missing = CHARTER_TABLES.filter((t) => !names.has(t));
                    return missing.length ? `missing ${missing.join(', ')}` : true;
                },
            },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    if (auth.client.publicKey) return true;
                    auth.ensureKey().catch(() => {});
                    return 'Network signing key not loaded yet: sign-in and service calls are unavailable';
                },
            },
            {
                name: 'events_relay', required: false,
                check: () => {
                    const s = outbox.status();
                    if (!s.enabled) return `relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset); ${s.pending} events waiting`;
                    if (s.rejected) return `${s.rejected} events rejected by OpenVibe.Events`;
                    return { ok: true, detail: { pending: s.pending } };
                },
            },
            {
                name: 'events_webhook', required: false,
                check: () => (config.events.webhookSecrets.length ? true : 'NEWS_EVENTS_SECRET unset: Events cannot deliver sources.item.* (the cursor pull still runs)'),
            },
            {
                name: 'sources_pull', required: false,
                check: () => {
                    const last = ingest.lastPull();
                    const off = !config.sources.pullIntervalMs || !config.worker.enabled;
                    if (!last) return off ? { ok: true, detail: { pull: 'off' } } : 'no pull from OpenVibe.Sources has run yet';
                    if (last.state !== 'ok') return `last pull failed (${last.error_code}): ${last.detail}`;
                    return { ok: true, detail: { cursor: last.cursor_after, at: new Date(last.at).toISOString() } };
                },
            },
        ],
    });
}

module.exports = { createNewsReadiness };
