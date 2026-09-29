'use strict';

/**
 * News' own PostgreSQL database (ADR-035, roadmap WS-X2): the schema is migrations/NNNN_*.sql, applied at boot. Nothing here is shared with another
 * service; the publishing packages create their tables inside this database with News' prefixes.
 *
 * The nine charter tables (roadmap §15.13):
 *
 *   news_topics             News-owned   canonical topic identities (slug, name); the only seed
 *   news_source_items       News-owned   normalised Sources items: headline, URL, outlet, authors,
 *                                        published_at and a licensed short summary — never a body;
 *                                        dedupe outcome, cluster, upstream state
 *   news_story_clusters     News-owned   deterministic clusters with their key terms and window
 *   news_stories            News-owned   publication state: slug, state, published revision, topic
 *   news_story_revisions    package      openvibe-publishing/revisions, prefix news_story (immutable)
 *   news_story_sources      News-owned   which source items a story rests on (the source table)
 *   news_perspectives       News-owned   editor-assigned groupings of a story's sources
 *   news_timeline_entries   News-owned   dated entries, each resting on one source item
 *   news_editorial_flags    News-owned   corrections, updates, retractions and upstream changes
 *
 * Also here, as companions (not authority for anything outside News):
 *   news_story_citations, news_story_reviews, news_story_drafts, news_story_revision_purges,
 *   news_story_discussion_refs (a story's Community thread id, never its comments),
 *   news_index_revisions (publishing packages); news_cluster_audit (every merge, split and reversal);
 *   news_ingest_runs (what each webhook delivery, pull and upstream failure did); news_ingest_cursor
 *   (the chassis' Sources change cursor; news_state holds the pre-chassis key it was carried from);
 *   news_source_status (a display cache of Sources' registry and health);
 *   event_outbox and idempotency_receipts (openvibe-sdk); subject_projections (Network names).
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createCitationStore } = require('openvibe-publishing/citations');
const { createReviewLog } = require('openvibe-publishing/authorship');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');
const { createDiscussionRefs } = require('openvibe-publishing/discussion');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh news)');
        const dir = config.db.pgliteDir || DEV_PGLITE;
        log.warn(`[News] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'news', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'news-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'news', registry, log });
}

/**
 * Every store on a migrated database handle. opts.now — injectable clock (epoch ms) shared by the stores, so tests
 * and replays are deterministic. store.tx(fn) is a transaction; inside it, plain db calls join it (ambient).
 */
function createStore(db, { now = () => Date.now() } = {}) {
    const revisions = createRevisionStore(db, { prefix: 'news_story', now });
    return {
        db,
        now,
        revisions,
        citations: createCitationStore(db, { prefix: 'news_story', now, revisions }),
        reviews: createReviewLog(db, { prefix: 'news_story', now }),
        sequencer: createIndexSequencer(db, { prefix: 'news', now }),
        discussion: createDiscussionRefs(db, { prefix: 'news_story', now }),
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

/** openDb + createStore. */
async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

const CHARTER_TABLES = ['news_topics', 'news_source_items', 'news_story_clusters', 'news_stories', 'news_story_revisions',
    'news_story_sources', 'news_perspectives', 'news_timeline_entries', 'news_editorial_flags'];

module.exports = { openDb, openStore, createStore, CHARTER_TABLES, MIGRATIONS };
