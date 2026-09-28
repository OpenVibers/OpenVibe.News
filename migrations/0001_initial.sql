-- phase: expand
-- OpenVibe.News on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk outbox. Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE news_topics (
    id           text COLLATE "C" PRIMARY KEY,                      -- top_<ULID>
    slug         text COLLATE "C" NOT NULL UNIQUE,
    name         text COLLATE "C" NOT NULL,
    description  text COLLATE "C",
    status       text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL
);

CREATE TABLE news_story_clusters (
    id             text COLLATE "C" PRIMARY KEY,                    -- clu_<ULID>
    seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- insertion order (the SQLite rowid tiebreak)
    label          text COLLATE "C" NOT NULL,                       -- derived from the key terms, never invented
    status         text COLLATE "C" NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','dissolved')),
    merged_into    text COLLATE "C" REFERENCES news_story_clusters(id),
    split_from     text COLLATE "C" REFERENCES news_story_clusters(id),
    terms          text COLLATE "C" NOT NULL DEFAULT '{}',          -- { term: count } over its members
    entities       text COLLATE "C" NOT NULL DEFAULT '{}',          -- { entity: count } over its members
    window_start   bigint,                             -- earliest member time (published_at, else first seen)
    window_end     bigint,                             -- latest member time
    created_by     text COLLATE "C" NOT NULL,                       -- 'svc:news' (clustering) or usr_… (a split)
    created_at     bigint NOT NULL,
    updated_at     bigint NOT NULL
);
CREATE INDEX news_story_clusters_open ON news_story_clusters (status, window_end);

CREATE TABLE news_source_items (
    id                  text COLLATE "C" PRIMARY KEY,               -- nsi_<ULID>
    seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- insertion order (the SQLite rowid tiebreak)
    sources_item_id     text COLLATE "C" NOT NULL UNIQUE,           -- itm_… in OpenVibe.Sources (a typed reference)
    sources_revision    bigint NOT NULL,               -- the Sources revision these fields came from
    source_key          text COLLATE "C" NOT NULL,
    canonical_url       text COLLATE "C",
    url_key             text COLLATE "C",                           -- normalised URL for dedupe
    headline            text COLLATE "C" NOT NULL,
    outlet              text COLLATE "C" NOT NULL,
    authors             text COLLATE "C" NOT NULL DEFAULT '[]',
    published_at        text COLLATE "C",                           -- as the source states it; NULL when it does not
    summary             text COLLATE "C",                           -- a short summary ONLY when the terms allow it
    summary_basis       text COLLATE "C",                           -- why a summary is (not) stored
    license_note        text COLLATE "C",
    terms_note          text COLLATE "C",
    content_hash        text COLLATE "C",                           -- Sources' hash of the parsed fields
    title_key           text COLLATE "C" NOT NULL,                  -- normalised headline for near-duplicate checks
    status              text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','duplicate','removed')),
    duplicate_of        text COLLATE "C" REFERENCES news_source_items(id),
    dedupe              text COLLATE "C",                           -- { rule, detail } when a duplicate
    cluster_id          text COLLATE "C" REFERENCES news_story_clusters(id),
    cluster_reason      text COLLATE "C",                           -- { rule, shared_entities, shared_terms, score } (explanation)
    retrieved_at        text COLLATE "C",
    first_seen_at       bigint NOT NULL,
    upstream_updated_at bigint,                        -- the last time Sources revised it after first ingest
    removed_at          bigint,
    removed_reason      text COLLATE "C",
    updated_at          bigint NOT NULL
);
CREATE INDEX news_source_items_url ON news_source_items (url_key);
CREATE INDEX news_source_items_hash ON news_source_items (content_hash);
CREATE INDEX news_source_items_cluster ON news_source_items (cluster_id);
CREATE INDEX news_source_items_seen ON news_source_items (first_seen_at);

CREATE TABLE news_stories (
    id                  text COLLATE "C" PRIMARY KEY,               -- sty_<ULID>
    slug                text COLLATE "C" NOT NULL UNIQUE,
    working_headline    text COLLATE "C" NOT NULL,                  -- the editors' latest headline (readers see the revision's)
    cluster_id          text COLLATE "C" REFERENCES news_story_clusters(id),
    topic_id            text COLLATE "C" REFERENCES news_topics(id),
    state               text COLLATE "C" NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','unpublished','retracted')),
    published_revision  bigint,                        -- which revision readers see (NULL: never published)
    first_published_at  bigint,
    published_at        bigint,                        -- the latest publication of published_revision
    retracted_at        bigint,
    noindex             bigint NOT NULL DEFAULT 0,     -- an editor asked search engines not to index it
    created_by          text COLLATE "C" NOT NULL,                  -- usr_… (the editor who opened the story)
    created_at          bigint NOT NULL,
    updated_at          bigint NOT NULL
);
CREATE INDEX news_stories_listing ON news_stories (state, published_at);
CREATE INDEX news_stories_topic ON news_stories (topic_id, state, published_at);
CREATE INDEX news_stories_cluster ON news_stories (cluster_id);

CREATE TABLE news_perspectives (
    id           text COLLATE "C" PRIMARY KEY,                      -- per_<ULID>
    seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- insertion order (the SQLite rowid tiebreak)
    story_id     text COLLATE "C" NOT NULL REFERENCES news_stories(id),
    label        text COLLATE "C" NOT NULL,                         -- written by an editor; never generated
    description  text COLLATE "C",
    position     bigint NOT NULL DEFAULT 0,
    created_by   text COLLATE "C" NOT NULL,
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL,
    removed_at   bigint
);
CREATE INDEX news_perspectives_story ON news_perspectives (story_id, position);

CREATE TABLE news_story_sources (
    story_id        text COLLATE "C" NOT NULL REFERENCES news_stories(id),
    source_item_id  text COLLATE "C" NOT NULL REFERENCES news_source_items(id),
    position        bigint NOT NULL,                   -- the [n] readers and editors cite
    perspective_id  text COLLATE "C" REFERENCES news_perspectives(id),
    added_by        text COLLATE "C" NOT NULL,
    added_at        bigint NOT NULL,
    detached_at     bigint,
    PRIMARY KEY (story_id, source_item_id)
);
CREATE INDEX news_story_sources_item ON news_story_sources (source_item_id);

CREATE TABLE news_timeline_entries (
    id              text COLLATE "C" PRIMARY KEY,                   -- tle_<ULID>
    seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- insertion order (the SQLite rowid tiebreak)
    story_id        text COLLATE "C" NOT NULL REFERENCES news_stories(id),
    occurred_on     text COLLATE "C" NOT NULL,                      -- YYYY-MM-DD or an ISO instant, as the source states it
    text            text COLLATE "C" NOT NULL,
    source_item_id  text COLLATE "C" NOT NULL REFERENCES news_source_items(id),
    created_by      text COLLATE "C" NOT NULL,
    created_at      bigint NOT NULL,
    removed_at      bigint
);
CREATE INDEX news_timeline_story ON news_timeline_entries (story_id, occurred_on);

CREATE TABLE news_editorial_flags (
    id              text COLLATE "C" PRIMARY KEY,                   -- flg_<ULID>
    seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- insertion order (the SQLite rowid tiebreak)
    story_id        text COLLATE "C" NOT NULL REFERENCES news_stories(id),
    kind            text COLLATE "C" NOT NULL CHECK (kind IN ('correction','update','retraction','source_updated','source_removed')),
    status          text COLLATE "C" NOT NULL DEFAULT 'open' CHECK (status IN ('open','published','resolved')),
    note            text COLLATE "C",                               -- public text for correction/update/retraction
    source_item_id  text COLLATE "C" REFERENCES news_source_items(id),
    pending_revision bigint,                           -- the revision the system prepared for an upstream change
    revision        bigint,                            -- the published revision it belongs to
    created_by      text COLLATE "C" NOT NULL,
    created_at      bigint NOT NULL,
    resolved_by     text COLLATE "C",
    resolved_at     bigint
);
CREATE INDEX news_flags_story ON news_editorial_flags (story_id, status, created_at);

-- Every merge, split and reversal, with exactly which items moved (so each can be undone).
CREATE TABLE news_cluster_audit (
    id            text COLLATE "C" PRIMARY KEY,                     -- cla_<ULID>
    seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- insertion order (the SQLite rowid tiebreak)
    action        text COLLATE "C" NOT NULL CHECK (action IN ('merge','split','reverse_merge','reverse_split')),
    cluster_id    text COLLATE "C" NOT NULL,                        -- merge: the surviving cluster; split: the source cluster
    other_id      text COLLATE "C" NOT NULL,                        -- merge: the absorbed cluster; split: the new cluster
    item_ids      text COLLATE "C" NOT NULL,                        -- JSON array of news_source_items ids that moved
    reason        text COLLATE "C",
    actor         text COLLATE "C" NOT NULL,
    reverses      text COLLATE "C" REFERENCES news_cluster_audit(id),
    reversed_by   text COLLATE "C" REFERENCES news_cluster_audit(id),
    created_at    bigint NOT NULL
);
CREATE INDEX news_cluster_audit_cluster ON news_cluster_audit (cluster_id, created_at);

-- What ingestion did: webhook deliveries, cursor pulls and upstream fetch failures.
CREATE TABLE news_ingest_runs (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    origin        text COLLATE "C" NOT NULL CHECK (origin IN ('webhook','pull','sources')),
    state         text COLLATE "C" NOT NULL,                        -- ok | failed | ignored | upstream state (http_error, timeout, …)
    source_key    text COLLATE "C",
    sources_item_id text COLLATE "C",
    error_code    text COLLATE "C",
    detail        text COLLATE "C",
    counts        text COLLATE "C",                                 -- { created, updated, removed, duplicates, unchanged }
    cursor_before bigint,
    cursor_after  bigint,
    at            bigint NOT NULL
);
CREATE INDEX news_ingest_runs_at ON news_ingest_runs (at);

CREATE TABLE news_state (
    key         text COLLATE "C" PRIMARY KEY,
    value       text COLLATE "C" NOT NULL,
    updated_at  bigint NOT NULL
);

-- Display cache of OpenVibe.Sources' registry (outlet names) and health; never authority.
CREATE TABLE news_source_status (
    source_key       text COLLATE "C" PRIMARY KEY,
    name             text COLLATE "C",
    homepage_url     text COLLATE "C",
    status           text COLLATE "C",
    stale            bigint,
    last_success_at  text COLLATE "C",
    refreshed_at     bigint NOT NULL
);

-- Display cache of Network names for subjects (from sign-in claims or identity.subject.resolve).
CREATE TABLE subject_projections (
    subject       text COLLATE "C" PRIMARY KEY,
    username      text COLLATE "C",
    display_name  text COLLATE "C",
    avatar_url    text COLLATE "C",
    refreshed_at  bigint NOT NULL
);
CREATE INDEX subject_projections_username ON subject_projections (username);

CREATE INDEX news_stories_published ON news_stories (published_at DESC, id) WHERE state = 'published';
-- openvibe-publishing/revisions (prefix news_story)
CREATE TABLE IF NOT EXISTS news_story_revisions (
    id            text PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    number        integer NOT NULL CHECK (number >= 1),
    parent_id     text,
    parent_number integer,
    kind          text NOT NULL CHECK (kind IN ('edit','revert','import')),
    reverted_to   integer,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    content_hash  text NOT NULL,
    author        text,
    message       text,
    created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS news_story_revisions_entity_num ON news_story_revisions (entity_id, number);
CREATE TABLE IF NOT EXISTS news_story_drafts (
    entity_id     text COLLATE "C" NOT NULL,
    owner         text COLLATE "C" NOT NULL,
    base_revision integer NOT NULL,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    PRIMARY KEY (entity_id, owner)
);
CREATE INDEX IF NOT EXISTS news_story_drafts_updated ON news_story_drafts (entity_id, updated_at DESC, owner);
CREATE TABLE IF NOT EXISTS news_story_revision_purges (
    entity_id   text COLLATE "C" PRIMARY KEY,
    reason      text NOT NULL,
    purged_by   text,
    purged_at   bigint NOT NULL
);
CREATE OR REPLACE FUNCTION news_story_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'news_story_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM news_story_revision_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'news_story_revisions rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER news_story_revisions_no_update BEFORE UPDATE ON news_story_revisions FOR EACH ROW EXECUTE FUNCTION news_story_revisions_guard();
CREATE OR REPLACE TRIGGER news_story_revisions_no_delete BEFORE DELETE ON news_story_revisions FOR EACH ROW EXECUTE FUNCTION news_story_revisions_guard();

-- openvibe-publishing/citations (prefix news_story)
CREATE TABLE IF NOT EXISTS news_story_citations (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id      text COLLATE "C" NOT NULL,
    revision       integer NOT NULL CHECK (revision >= 1),
    anchor         text,
    source_item_id text COLLATE "C",
    url            text,
    title          text,
    retrieved_at   timestamptz,
    quote_text     text,
    quote_start    integer,
    quote_end      integer,
    license_note   text,
    carried_from   bigint REFERENCES news_story_citations(id),
    attached_by    text,
    attached_at    bigint NOT NULL,
    CHECK (source_item_id IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS news_story_citations_rev ON news_story_citations (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS news_story_citations_source ON news_story_citations (source_item_id, entity_id, revision, id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_story_citations_carried ON news_story_citations (carried_from) WHERE carried_from IS NOT NULL;
CREATE TABLE IF NOT EXISTS news_story_citation_purges (
    entity_id text COLLATE "C" PRIMARY KEY,
    reason    text NOT NULL,
    purged_by text,
    purged_at bigint NOT NULL
);
CREATE OR REPLACE FUNCTION news_story_citations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'news_story_citations rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM news_story_citation_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'news_story_citations rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER news_story_citations_no_update BEFORE UPDATE ON news_story_citations FOR EACH ROW EXECUTE FUNCTION news_story_citations_guard();
CREATE OR REPLACE TRIGGER news_story_citations_no_delete BEFORE DELETE ON news_story_citations FOR EACH ROW EXECUTE FUNCTION news_story_citations_guard();

-- openvibe-publishing/authorship (prefix news_story)
CREATE TABLE IF NOT EXISTS news_story_reviews (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id   text COLLATE "C" NOT NULL,
    revision    integer NOT NULL,
    reviewer    text NOT NULL,
    decision    text NOT NULL CHECK (decision IN ('approved','rejected')),
    note        text,
    reviewed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS news_story_reviews_rev ON news_story_reviews (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS news_story_reviews_entity ON news_story_reviews (entity_id, id);
CREATE OR REPLACE FUNCTION news_story_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'news_story_reviews rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER news_story_reviews_no_update BEFORE UPDATE ON news_story_reviews FOR EACH ROW EXECUTE FUNCTION news_story_reviews_guard();

-- openvibe-publishing/index-hooks (prefix news)
CREATE TABLE IF NOT EXISTS news_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);

-- openvibe-publishing/discussion (prefix news_story)
CREATE TABLE IF NOT EXISTS news_story_discussion_refs (
    entity_id   text COLLATE "C" PRIMARY KEY,
    thread_id   text NOT NULL,
    ref         jsonb NOT NULL,
    resolved_at bigint NOT NULL
);

-- openvibe-sdk/events inbox: one receipt per (consumer, event) handled
CREATE TABLE IF NOT EXISTS idempotency_receipts (
    consumer     text NOT NULL,
    event_id     text NOT NULL,
    processed_at bigint NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
