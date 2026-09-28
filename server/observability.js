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
const { createReadiness, skip } = require('openvibe-shared/ready');
const { CHARTER_TABLES } = require('./db');

function createNewsReadiness({ store, auth, outbox, ingest, config, valkey = null, release = null }) {
    const { db } = store;
    return createReadiness({
        service: 'news',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: async () => {
                    // A real round trip that names the store (postgresql / pglite), and the charter tables present.
                    const r = await db.ready();
                    if (!r.ok) return r.error;
                    const names = new Set((await db.prepare('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()').all()).map((x) => x.name));
                    const missing = CHARTER_TABLES.filter((t) => !names.has(t));
                    return missing.length ? `missing ${missing.join(', ')} (migrations did not run)` : { ok: true, detail: r.detail };
                },
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-actor limits count in this process only' }) },
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
                check: async () => {
                    const s = await outbox.status();
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
                check: async () => {
                    const last = await ingest.lastPull();
                    const off = !config.sources.pullIntervalMs || !config.worker.enabled;
                    // Pull switched off and never run: nothing verified, so skipped, never ok (WS-Q task 7).
                    if (!last) return off ? skip('pull off (NEWS_PULL_INTERVAL_MS=0 or NEWS_WORKER=off)', { pull: 'off' }) : 'no pull from OpenVibe.Sources has run yet';
                    if (last.state !== 'ok') return `last pull failed (${last.error_code}): ${last.detail}`;
                    return { ok: true, detail: { cursor: last.cursor_after, at: new Date(last.at).toISOString() } };
                },
            },
        ],
    });
}

module.exports = { createNewsReadiness };
