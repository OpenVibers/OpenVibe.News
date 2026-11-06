-- phase: migrate
-- Every story that existed before sharing is registered once, and its audience column says what
-- the lists should hold: a published (or retracted) story was Everyone; a draft is Only me.
--
-- The owner is the editor who opened it; a service-made story gets News itself, which nobody can
-- sign in as.
UPDATE news_stories SET audience = CASE WHEN state IN ('published', 'retracted') THEN 'public' ELSE 'private' END;

INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'news', 'story', s.id,
    CASE
        WHEN s.created_by LIKE 'usr\_%' THEN jsonb_build_object('type', 'user', 'id', s.created_by)
        WHEN s.created_by LIKE 'gst\_%' THEN jsonb_build_object('type', 'guest', 'id', s.created_by)
        ELSE jsonb_build_object('type', 'service', 'id', 'news')
    END,
    CASE WHEN s.state IN ('published', 'retracted') THEN 'public' ELSE 'private' END
FROM news_stories s
ON CONFLICT (service, kind, resource_id) DO NOTHING;
