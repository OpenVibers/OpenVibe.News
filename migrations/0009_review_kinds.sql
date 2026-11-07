-- phase: expand
-- Two reviewer kinds in both append-only review logs (server/domain/review-kind.js and
-- server/domain/briefs.js; the AI editor review of the editorial queue, plan 2026-10-22
-- §"The editorial queue"):
--
--   person     a signed-in person's approval or rejection (the default; every row written before
--              this migration, and every row openvibe-publishing/authorship reviews.record() writes);
--   ai_editor  the orchestrator's service principal, which holds news.review.ai_editor.
--
-- Expand only: existing rows keep their meaning through the default, and code that does not know
-- the column (the shared log's INSERT for stories, older processes during a rolling deploy) keeps working.
ALTER TABLE news_story_reviews
    ADD COLUMN IF NOT EXISTS reviewer_kind text NOT NULL DEFAULT 'person'
        CHECK (reviewer_kind IN ('person', 'ai_editor'));

ALTER TABLE news_brief_reviews
    ADD COLUMN IF NOT EXISTS reviewer_kind text NOT NULL DEFAULT 'person'
        CHECK (reviewer_kind IN ('person', 'ai_editor'));
