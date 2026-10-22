'use strict';
/**
 * What the front page counts and groups, besides the stories, briefs and wire it already lists. Read from News'
 * own database; only live reports (active, not removed) and open clusters count, as on the wire:
 *
 *   stats()        reports first seen in the last day and the last seven, the outlets that reported in the last 30 days,
 *                  the AI briefs there are, the topics and the published stories
 *   outlets()      each outlet of the last 30 days: its reports this week and in those 30 days, and its newest report
 *   topicTally()   each topic's subjects and reports over the last 30 days (server/domain/topic-match.js, the topic
 *                  pages' own rule) and its newest subject with that subject's newest report
 *
 * The front page is cached for everyone: nothing here depends on who is looking.
 */
const { topicsFor } = require('./topic-match');

const DAY = 86400000;
const LIVE = "i.status = 'active' AND i.removed_at IS NULL";

function createHome({ store }) {
    const { db } = store;
    const q = {
        stats: db.prepare(`SELECT (SELECT COUNT(*) FROM news_source_items i WHERE ${LIVE} AND i.first_seen_at >= ?) AS day,
                                  (SELECT COUNT(*) FROM news_source_items i WHERE ${LIVE} AND i.first_seen_at >= ?) AS week,
                                  (SELECT COUNT(DISTINCT i.outlet) FROM news_source_items i WHERE ${LIVE} AND i.first_seen_at >= ?) AS outlets,
                                  (SELECT COUNT(*) FROM news_cluster_briefs b JOIN news_story_clusters c ON c.id = b.cluster_id
                                    WHERE b.kind = 'summary' AND b.tone = 'neutral' AND b.stub = false AND c.status = 'open') AS briefs,
                                  (SELECT COUNT(*) FROM news_topics WHERE status = 'active') AS topics,
                                  (SELECT COUNT(*) FROM news_stories WHERE state = 'published') AS stories`),
        outlets: db.prepare(`SELECT i.outlet, COUNT(*) AS month, COUNT(*) FILTER (WHERE i.first_seen_at >= ?) AS week
                             FROM news_source_items i WHERE ${LIVE} AND i.first_seen_at >= ? GROUP BY i.outlet ORDER BY week DESC, month DESC, i.outlet`),
        newestByOutlet: db.prepare(`SELECT DISTINCT ON (i.outlet) i.outlet, i.headline, i.canonical_url, i.published_at, i.first_seen_at
                                    FROM news_source_items i WHERE ${LIVE} AND i.first_seen_at >= ? AND i.canonical_url IS NOT NULL
                                    ORDER BY i.outlet, i.first_seen_at DESC, i.id DESC`),
        recentMembers: db.prepare(`SELECT c.id AS cid, c.label, c.window_end, i.headline, i.canonical_url, i.outlet, i.published_at, i.source_key
                                   FROM news_story_clusters c JOIN news_source_items i ON i.cluster_id = c.id
                                   WHERE c.status = 'open' AND c.window_end >= ? AND ${LIVE}
                                   ORDER BY c.window_end DESC, c.id DESC`),
    };
    const n = (v) => Number(v) || 0;
    return {
        async stats() {
            const now = store.now();
            const r = (await q.stats.get(now - DAY, now - 7 * DAY, now - 30 * DAY)) || {};
            return { day: n(r.day), week: n(r.week), outlets: n(r.outlets), briefs: n(r.briefs), topics: n(r.topics), stories: n(r.stories) };
        },
        async outlets() {
            const now = store.now();
            const [rows, newest] = await Promise.all([q.outlets.all(now - 7 * DAY, now - 30 * DAY), q.newestByOutlet.all(now - 30 * DAY)]);
            const latest = new Map(newest.map((r) => [r.outlet, { headline: r.headline, url: r.canonical_url, published_at: r.published_at }]));
            return rows.map((r) => ({ outlet: r.outlet, week: n(r.week), month: n(r.month), latest: latest.get(r.outlet) || null }));
        },
        /** Map slug → { subjects, reports, newest: { id, label, item } } over the last 30 days. */
        async topicTally({ days = 30 } = {}) {
            const rows = await q.recentMembers.all(store.now() - days * DAY);
            const byCluster = new Map();
            for (const r of rows) {
                if (!byCluster.has(r.cid)) byCluster.set(r.cid, { id: r.cid, label: r.label, updated: n(r.window_end), items: [], sources: new Set() });
                const c = byCluster.get(r.cid);
                c.sources.add(r.source_key);
                c.items.push({ headline: r.headline, url: r.canonical_url, outlet: r.outlet, published_at: r.published_at });
            }
            const out = new Map();
            for (const c of byCluster.values()) {        // newest activity first, as the query orders them
                for (const slug of topicsFor({ label: c.label, headlines: c.items.map((i) => i.headline), sources: [...c.sources] })) {
                    if (!out.has(slug)) {
                        const item = c.items.filter((i) => i.url).sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))[0] || null;
                        out.set(slug, { subjects: 0, reports: 0, newest: { id: c.id, label: c.label, item } });
                    }
                    const t = out.get(slug);
                    t.subjects += 1;
                    t.reports += c.items.length;
                }
            }
            return out;
        },
    };
}

module.exports = { createHome };
