-- phase: expand
-- AI briefs (server/domain/briefs.js; the owner's April ask: multi-source summaries with tone and perspective controls).
-- One row per cluster, kind and tone: a summary of what the cluster's reports say (tone brief | neutral | explained),
-- or how its outlets frame it (kind perspectives). Every paragraph cites the source items it rests on; the model's
-- uncited claims are dropped and listed in gaps. A brief is AI text, labelled as such, never a story: stories stay
-- editor-written. A brief is stale once its cluster changes (item_count or cluster_updated_at) and is made again.
CREATE TABLE IF NOT EXISTS news_cluster_briefs (
    cluster_id          text COLLATE "C" NOT NULL REFERENCES news_story_clusters(id) ON DELETE CASCADE,
    kind                text COLLATE "C" NOT NULL CHECK (kind IN ('summary', 'perspectives')),
    tone                text COLLATE "C" NOT NULL DEFAULT 'neutral' CHECK (tone IN ('brief', 'neutral', 'explained')),
    headline            text COLLATE "C",
    paragraphs          text COLLATE "C" NOT NULL,             -- JSON [{ text, sources: [nsi_…] }]
    source_ids          text COLLATE "C" NOT NULL,             -- JSON [nsi_…] the reports it was made from, in order
    gaps                text COLLATE "C" NOT NULL DEFAULT '[]',
    run_id              text COLLATE "C",
    model               text COLLATE "C",
    stub                boolean NOT NULL DEFAULT false,         -- the stub provider's synthetic output: never shown
    item_count          integer NOT NULL,
    cluster_updated_at  bigint NOT NULL,
    created_at          bigint NOT NULL,
    PRIMARY KEY (cluster_id, kind, tone)
);
CREATE INDEX IF NOT EXISTS news_cluster_briefs_recent ON news_cluster_briefs (kind, tone, created_at DESC);
