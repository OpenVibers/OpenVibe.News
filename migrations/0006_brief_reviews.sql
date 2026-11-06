-- phase: expand
-- AI briefs are published only after a person reviews them (server/domain/briefs.js, the reviewer queue).
-- Append-only, like news_story_reviews: a review names the person, the decision and the brief it reviewed.
-- brief_created_at is part of the review: when the sweep remakes a brief after its cluster changes, the
-- old approval no longer applies and the page waits for a person again.
CREATE TABLE IF NOT EXISTS news_brief_reviews (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cluster_id       text COLLATE "C" NOT NULL,
    kind             text COLLATE "C" NOT NULL CHECK (kind IN ('summary', 'perspectives')),
    tone             text COLLATE "C" NOT NULL CHECK (tone IN ('brief', 'neutral', 'explained')),
    brief_created_at bigint NOT NULL,
    reviewer         text NOT NULL,
    decision         text NOT NULL CHECK (decision IN ('approved', 'rejected')),
    note             text,
    reviewed_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS news_brief_reviews_latest ON news_brief_reviews (cluster_id, kind, tone, id);
CREATE OR REPLACE FUNCTION news_brief_reviews_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'news_brief_reviews rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS news_brief_reviews_no_update ON news_brief_reviews;
CREATE TRIGGER news_brief_reviews_no_update BEFORE UPDATE ON news_brief_reviews FOR EACH ROW EXECUTE FUNCTION news_brief_reviews_guard();
DROP TRIGGER IF EXISTS news_brief_reviews_no_delete ON news_brief_reviews;
CREATE TRIGGER news_brief_reviews_no_delete BEFORE DELETE ON news_brief_reviews FOR EACH ROW EXECUTE FUNCTION news_brief_reviews_guard();
