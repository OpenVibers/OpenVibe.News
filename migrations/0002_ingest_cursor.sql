-- phase: expand
-- The ingest cursor moves from news_state ('sources_cursor') to the chassis' own table
-- (openvibe-publishing/ingest, prefix news → news_ingest_cursor). Additive: the old key is read
-- once here so a deployment continues from the cursor it had, never from zero. Generated from
-- require('openvibe-publishing').schema({ ingest: 'news' }).

CREATE TABLE IF NOT EXISTS news_ingest_cursor (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);

-- Continuity: carry the cursor already stored under the old key, once. news_state stores JSON, so a
-- numeric value is plain digits; anything else is ignored (the chassis cursor then starts empty).
INSERT INTO news_ingest_cursor (name, cursor, updated_at)
SELECT 'sources', value::bigint, (EXTRACT(EPOCH FROM now()) * 1000)::bigint
FROM news_state
WHERE key = 'sources_cursor' AND value ~ '^[0-9]+$'
ON CONFLICT (name) DO NOTHING;
