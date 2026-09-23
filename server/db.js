'use strict';

/**
 * News' own SQLite database: created on boot, idempotently. Nothing here is shared with another
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
 *   news_index_revisions (publishing packages); news_cluster_audit (every merge, split and reversal);
 *   news_ingest_runs (what each webhook delivery, pull and upstream failure did); news_state (the
 *   Sources cursor); news_source_status (a display cache of Sources' registry and health);
 *   event_outbox and idempotency_receipts (openvibe-sdk); subject_projections (Network names).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createCitationStore } = require('openvibe-publishing/citations');
const { createReviewLog } = require('openvibe-publishing/authorship');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS news_topics (
    id           TEXT PRIMARY KEY,                      -- top_<ULID>
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS news_story_clusters (
    id             TEXT PRIMARY KEY,                    -- clu_<ULID>
    label          TEXT NOT NULL,                       -- derived from the key terms, never invented
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','dissolved')),
    merged_into    TEXT REFERENCES news_story_clusters(id),
    split_from     TEXT REFERENCES news_story_clusters(id),
    terms          TEXT NOT NULL DEFAULT '{}',          -- { term: count } over its members
    entities       TEXT NOT NULL DEFAULT '{}',          -- { entity: count } over its members
    window_start   INTEGER,                             -- earliest member time (published_at, else first seen)
    window_end     INTEGER,                             -- latest member time
    created_by     TEXT NOT NULL,                       -- 'svc:news' (clustering) or usr_… (a split)
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_story_clusters_open ON news_story_clusters (status, window_end);

CREATE TABLE IF NOT EXISTS news_source_items (
    id                  TEXT PRIMARY KEY,               -- nsi_<ULID>
    sources_item_id     TEXT NOT NULL UNIQUE,           -- itm_… in OpenVibe.Sources (a typed reference)
    sources_revision    INTEGER NOT NULL,               -- the Sources revision these fields came from
    source_key          TEXT NOT NULL,
    canonical_url       TEXT,
    url_key             TEXT,                           -- normalised URL for dedupe
    headline            TEXT NOT NULL,
    outlet              TEXT NOT NULL,
    authors             TEXT NOT NULL DEFAULT '[]',
    published_at        TEXT,                           -- as the source states it; NULL when it does not
    summary             TEXT,                           -- a short summary ONLY when the terms allow it
    summary_basis       TEXT,                           -- why a summary is (not) stored
    license_note        TEXT,
    terms_note          TEXT,
    content_hash        TEXT,                           -- Sources' hash of the parsed fields
    title_key           TEXT NOT NULL,                  -- normalised headline for near-duplicate checks
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','duplicate','removed')),
    duplicate_of        TEXT REFERENCES news_source_items(id),
    dedupe              TEXT,                           -- { rule, detail } when a duplicate
    cluster_id          TEXT REFERENCES news_story_clusters(id),
    cluster_reason      TEXT,                           -- { rule, shared_entities, shared_terms, score } (explanation)
    retrieved_at        TEXT,
    first_seen_at       INTEGER NOT NULL,
    upstream_updated_at INTEGER,                        -- the last time Sources revised it after first ingest
    removed_at          INTEGER,
    removed_reason      TEXT,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_source_items_url ON news_source_items (url_key);
CREATE INDEX IF NOT EXISTS news_source_items_hash ON news_source_items (content_hash);
CREATE INDEX IF NOT EXISTS news_source_items_cluster ON news_source_items (cluster_id);
CREATE INDEX IF NOT EXISTS news_source_items_seen ON news_source_items (first_seen_at);

CREATE TABLE IF NOT EXISTS news_stories (
    id                  TEXT PRIMARY KEY,               -- sty_<ULID>
    slug                TEXT NOT NULL UNIQUE,
    working_headline    TEXT NOT NULL,                  -- the editors' latest headline (readers see the revision's)
    cluster_id          TEXT REFERENCES news_story_clusters(id),
    topic_id            TEXT REFERENCES news_topics(id),
    state               TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','unpublished','retracted')),
    published_revision  INTEGER,                        -- which revision readers see (NULL: never published)
    first_published_at  INTEGER,
    published_at        INTEGER,                        -- the latest publication of published_revision
    retracted_at        INTEGER,
    noindex             INTEGER NOT NULL DEFAULT 0,     -- an editor asked search engines not to index it
    created_by          TEXT NOT NULL,                  -- usr_… (the editor who opened the story)
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_stories_listing ON news_stories (state, published_at);
CREATE INDEX IF NOT EXISTS news_stories_topic ON news_stories (topic_id, state, published_at);
CREATE INDEX IF NOT EXISTS news_stories_cluster ON news_stories (cluster_id);

CREATE TABLE IF NOT EXISTS news_perspectives (
    id           TEXT PRIMARY KEY,                      -- per_<ULID>
    story_id     TEXT NOT NULL REFERENCES news_stories(id),
    label        TEXT NOT NULL,                         -- written by an editor; never generated
    description  TEXT,
    position     INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    removed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS news_perspectives_story ON news_perspectives (story_id, position);

CREATE TABLE IF NOT EXISTS news_story_sources (
    story_id        TEXT NOT NULL REFERENCES news_stories(id),
    source_item_id  TEXT NOT NULL REFERENCES news_source_items(id),
    position        INTEGER NOT NULL,                   -- the [n] readers and editors cite
    perspective_id  TEXT REFERENCES news_perspectives(id),
    added_by        TEXT NOT NULL,
    added_at        INTEGER NOT NULL,
    detached_at     INTEGER,
    PRIMARY KEY (story_id, source_item_id)
);
CREATE INDEX IF NOT EXISTS news_story_sources_item ON news_story_sources (source_item_id);

CREATE TABLE IF NOT EXISTS news_timeline_entries (
    id              TEXT PRIMARY KEY,                   -- tle_<ULID>
    story_id        TEXT NOT NULL REFERENCES news_stories(id),
    occurred_on     TEXT NOT NULL,                      -- YYYY-MM-DD or an ISO instant, as the source states it
    text            TEXT NOT NULL,
    source_item_id  TEXT NOT NULL REFERENCES news_source_items(id),
    created_by      TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    removed_at      INTEGER
);
CREATE INDEX IF NOT EXISTS news_timeline_story ON news_timeline_entries (story_id, occurred_on);

CREATE TABLE IF NOT EXISTS news_editorial_flags (
    id              TEXT PRIMARY KEY,                   -- flg_<ULID>
    story_id        TEXT NOT NULL REFERENCES news_stories(id),
    kind            TEXT NOT NULL CHECK (kind IN ('correction','update','retraction','source_updated','source_removed')),
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','published','resolved')),
    note            TEXT,                               -- public text for correction/update/retraction
    source_item_id  TEXT REFERENCES news_source_items(id),
    pending_revision INTEGER,                           -- the revision the system prepared for an upstream change
    revision        INTEGER,                            -- the published revision it belongs to
    created_by      TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    resolved_by     TEXT,
    resolved_at     INTEGER
);
CREATE INDEX IF NOT EXISTS news_flags_story ON news_editorial_flags (story_id, status, created_at);

-- Every merge, split and reversal, with exactly which items moved (so each can be undone).
CREATE TABLE IF NOT EXISTS news_cluster_audit (
    id            TEXT PRIMARY KEY,                     -- cla_<ULID>
    action        TEXT NOT NULL CHECK (action IN ('merge','split','reverse_merge','reverse_split')),
    cluster_id    TEXT NOT NULL,                        -- merge: the surviving cluster; split: the source cluster
    other_id      TEXT NOT NULL,                        -- merge: the absorbed cluster; split: the new cluster
    item_ids      TEXT NOT NULL,                        -- JSON array of news_source_items ids that moved
    reason        TEXT,
    actor         TEXT NOT NULL,
    reverses      TEXT REFERENCES news_cluster_audit(id),
    reversed_by   TEXT REFERENCES news_cluster_audit(id),
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_cluster_audit_cluster ON news_cluster_audit (cluster_id, created_at);

-- What ingestion did: webhook deliveries, cursor pulls and upstream fetch failures.
CREATE TABLE IF NOT EXISTS news_ingest_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    origin        TEXT NOT NULL CHECK (origin IN ('webhook','pull','sources')),
    state         TEXT NOT NULL,                        -- ok | failed | ignored | upstream state (http_error, timeout, …)
    source_key    TEXT,
    sources_item_id TEXT,
    error_code    TEXT,
    detail        TEXT,
    counts        TEXT,                                 -- { created, updated, removed, duplicates, unchanged }
    cursor_before INTEGER,
    cursor_after  INTEGER,
    at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_ingest_runs_at ON news_ingest_runs (at);

CREATE TABLE IF NOT EXISTS news_state (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Display cache of OpenVibe.Sources' registry (outlet names) and health; never authority.
CREATE TABLE IF NOT EXISTS news_source_status (
    source_key       TEXT PRIMARY KEY,
    name             TEXT,
    homepage_url     TEXT,
    status           TEXT,
    stale            INTEGER,
    last_success_at  TEXT,
    refreshed_at     INTEGER NOT NULL
);

-- Display cache of Network names for subjects (from sign-in claims or identity.subject.resolve).
CREATE TABLE IF NOT EXISTS subject_projections (
    subject       TEXT PRIMARY KEY,
    username      TEXT,
    display_name  TEXT,
    avatar_url    TEXT,
    refreshed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subject_projections_username ON subject_projections (username);
`;

/**
 * Open (or create) the database and every store on it.
 * opts.now — injectable clock (epoch ms) shared by the stores, so tests and replays are deterministic.
 */
function openStore(dbPath, { now = () => Date.now() } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);

    const revisions = createRevisionStore(db, { prefix: 'news_story', now });
    const store = {
        db,
        now,
        revisions,
        citations: createCitationStore(db, { prefix: 'news_story', now, revisions }),
        reviews: createReviewLog(db, { prefix: 'news_story', now }),
        sequencer: createIndexSequencer(db, { prefix: 'news', now }),
        tx: (fn) => db.transaction(fn)(),
        getState(key, def = null) {
            const r = db.prepare('SELECT value FROM news_state WHERE key = ?').get(key);
            return r ? JSON.parse(r.value) : def;
        },
        setState(key, value) {
            db.prepare(`INSERT INTO news_state (key, value, updated_at) VALUES (?, ?, ?)
                        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), now());
        },
        close: () => db.close(),
    };
    return store;
}

const CHARTER_TABLES = ['news_topics', 'news_source_items', 'news_story_clusters', 'news_stories', 'news_story_revisions',
    'news_story_sources', 'news_perspectives', 'news_timeline_entries', 'news_editorial_flags'];

module.exports = { openStore, CHARTER_TABLES };
