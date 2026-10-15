'use strict';

/**
 * AI briefs: what a cluster's reports say, written by OpenVibe.AI and labelled as AI (migrations/0004_cluster_briefs.sql).
 * The owner's April ask for News: multi-source summarization, tone controls and perspective/slant controls, and a live
 * breaking view. Stories stay what they were: editor-written, every paragraph cited, never AI text without a person's
 * approval. A brief is the other thing: an AI summary of a cluster, shown as such, beside the wire.
 *
 *   summary        news.summarize_story over the cluster's live reports, in a tone: brief, neutral (made by the sweep
 *                  for every cluster with at least MIN_REPORTS reports) or explained (made when a reader asks)
 *   perspectives   news.compare_perspectives: how the outlets frame it (when a reader asks; two outlets or more)
 *
 * Only News' stored fields go to AI (headline, outlet, date, URL, and the short summary its terms allow). A paragraph the
 * model did not cite is dropped (clients/ai.js draftFromOutput) and listed as a gap; a run with no cited text makes no
 * brief. The stub provider's synthetic output is stored but never shown. A brief made from a cluster that has since
 * changed is stale and is made again (the sweep for neutral summaries, the next reader's request for the rest).
 */

const { draftFromOutput } = require('../clients/ai');

const TONES = ['brief', 'neutral', 'explained'];
const TONE_TEXT = { brief: 'In brief', neutral: 'Summary', explained: 'Explained' };
const KINDS = ['summary', 'perspectives'];
const MIN_REPORTS = 2;
const SWEEP_PER_TICK = 6;
const SWEEP_WINDOW_MS = 72 * 3_600_000;

const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch { return d; } };

function createBriefs({ store, ai, log = console }) {
    const db = store.db;
    const q = {
        cluster: db.prepare("SELECT * FROM news_story_clusters WHERE id = ? AND status = 'open'"),
        reports: db.prepare("SELECT * FROM news_source_items WHERE cluster_id = ? AND status = 'active' AND removed_at IS NULL ORDER BY published_at, first_seen_at, seq"),
        get: db.prepare('SELECT * FROM news_cluster_briefs WHERE cluster_id = ? AND kind = ? AND tone = ?'),
        put: db.prepare(`INSERT INTO news_cluster_briefs (cluster_id, kind, tone, headline, paragraphs, source_ids, gaps, run_id, model, stub, item_count, cluster_updated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (cluster_id, kind, tone) DO UPDATE SET headline = excluded.headline, paragraphs = excluded.paragraphs, source_ids = excluded.source_ids,
                gaps = excluded.gaps, run_id = excluded.run_id, model = excluded.model, stub = excluded.stub, item_count = excluded.item_count,
                cluster_updated_at = excluded.cluster_updated_at, created_at = excluded.created_at`),
        latest: db.prepare(`SELECT b.*, c.label, c.window_end FROM news_cluster_briefs b JOIN news_story_clusters c ON c.id = b.cluster_id
            WHERE b.kind = 'summary' AND b.tone = 'neutral' AND b.stub = false AND c.status = 'open' ORDER BY c.window_end DESC, b.created_at DESC LIMIT ?`),
        // Open clusters active in the window with at least MIN_REPORTS live reports, newest activity first.
        due: db.prepare(`SELECT c.id, c.updated_at, count(i.id) AS n FROM news_story_clusters c JOIN news_source_items i ON i.cluster_id = c.id AND i.status = 'active' AND i.removed_at IS NULL
            WHERE c.status = 'open' AND c.window_end >= ? GROUP BY c.id, c.updated_at, c.window_end HAVING count(i.id) >= ? ORDER BY c.window_end DESC LIMIT 200`),
    };

    const fresh = (row, cluster, n) => Boolean(row && Number(row.item_count) === n && Number(row.cluster_updated_at) === Number(cluster.updated_at));

    /** The stored brief, and whether it still matches its cluster. */
    async function get(clusterId, { kind = 'summary', tone = 'neutral' } = {}) {
        const cluster = await q.cluster.get(clusterId);
        if (!cluster) return null;
        const reports = await q.reports.all(cluster.id);
        const row = await q.get.get(cluster.id, kind, tone);
        return { cluster, reports, brief: row ? shape(row) : null, fresh: fresh(row, cluster, reports.length) };
    }

    function shape(row) {
        return {
            cluster_id: row.cluster_id, kind: row.kind, tone: row.tone, headline: row.headline || null,
            paragraphs: parse(row.paragraphs, []), source_ids: parse(row.source_ids, []), gaps: parse(row.gaps, []),
            run_id: row.run_id || null, model: row.model || null, stub: Boolean(row.stub), item_count: Number(row.item_count), created_at: Number(row.created_at),
        };
    }

    /** Make (or remake) one brief. Throws the AI client's error when the run fails; makes nothing without cited text. */
    async function make(clusterId, { kind = 'summary', tone = 'neutral' } = {}) {
        if (!ai || !ai.enabled) throw Object.assign(new Error('OpenVibe.AI is not configured on this server'), { code: 'ai.not_configured', status: 503 });
        if (!KINDS.includes(kind) || !TONES.includes(tone)) throw Object.assign(new Error('kind or tone not known'), { code: 'brief.invalid', status: 422 });
        const cluster = await q.cluster.get(clusterId);
        if (!cluster) throw Object.assign(new Error('No such cluster'), { code: 'cluster.not_found', status: 404 });
        const reports = await q.reports.all(cluster.id);
        if (!reports.length) throw Object.assign(new Error('This cluster has no live reports'), { code: 'brief.no_reports', status: 422 });
        const outlets = new Set(reports.map((r) => r.outlet));
        if (kind === 'perspectives' && outlets.size < 2) throw Object.assign(new Error('Comparing how outlets frame it needs two outlets or more'), { code: 'brief.one_outlet', status: 422 });
        const workflow = kind === 'perspectives' ? 'news.compare_perspectives' : 'news.summarize_story';
        const result = await ai.run(workflow, {
            topic: cluster.label, tone: kind === 'summary' ? tone : null,
            sources: reports.map((r) => ({ id: r.id, sources_item_id: r.sources_item_id, headline: r.headline, url: r.canonical_url, outlet: r.outlet,
                authors: parse(r.authors, []), published_at: r.published_at, retrieved_at: r.retrieved_at, summary: r.summary })),
        });
        const ids = reports.map((r) => r.id);
        const draft = draftFromOutput(workflow, result.output, ids);
        if (!draft.paragraphs.length) throw Object.assign(new Error('The AI run returned no cited text; no brief was made'), { code: 'brief.nothing_cited', status: 422 });
        await q.put.run(cluster.id, kind, tone, draft.headline, JSON.stringify(draft.paragraphs), JSON.stringify(ids), JSON.stringify(draft.gaps),
            result.runId, (result.workflow && result.workflow.model) || null, Boolean(result.stub), reports.length, Number(cluster.updated_at), store.now());
        return get(cluster.id, { kind, tone });
    }

    /** The sweep: neutral summaries for the busiest recent clusters that have none, or a stale one. */
    async function sweep({ limit = SWEEP_PER_TICK } = {}) {
        if (!ai || !ai.enabled) return 0;
        let made = 0;
        for (const c of await q.due.all(store.now() - SWEEP_WINDOW_MS, MIN_REPORTS)) {
            if (made >= limit) break;
            const row = await q.get.get(c.id, 'summary', 'neutral');
            if (fresh(row, c, Number(c.n))) continue;
            try { await make(c.id, { kind: 'summary', tone: 'neutral' }); made += 1; } catch (err) {
                (log.warn || log.log)(`[News] brief for ${c.id}: ${err.code || err.message}`);
                if (String(err.code || '').startsWith('ai.')) break;   // AI is down or refusing: try again next tick
            }
        }
        return made;
    }

    const latest = async (limit = 12) => (await q.latest.all(limit)).map((r) => ({ ...shape(r), label: r.label, window_end: Number(r.window_end) }));

    return { TONES, TONE_TEXT, KINDS, MIN_REPORTS, get, make, sweep, latest };
}

module.exports = { createBriefs, TONES, TONE_TEXT, MIN_REPORTS };
