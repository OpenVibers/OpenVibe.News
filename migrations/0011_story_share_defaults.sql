-- phase: expand
-- Each editor's new story drafts start Only me, or Specific people until names are added in the sheet.
CREATE TABLE IF NOT EXISTS news_share_defaults (
    owner_subject text COLLATE "C" PRIMARY KEY,
    audience text NOT NULL CHECK (audience IN ('private', 'people')),
    updated_at timestamptz NOT NULL DEFAULT now()
);
