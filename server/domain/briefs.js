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
 * Below minOutlets independent outlets (the market research's lesson from Ground News: withhold the summary when too
 * few distinct outlets covered a story) no summary is written, made or shown: the page lists the reports and says why.
 * It is the same number that decides whether a story may be indexed (config.indexing.minIndependentSources).
 *
 * Only News' stored fields go to AI (headline, outlet, date, URL, and the short summary its terms allow). A paragraph the
 * model did not cite is dropped (clients/ai.js draftFromOutput) and listed as a gap; a run with no cited text makes no
 * brief. The stub provider's synthetic output is stored but never shown. A brief made from a cluster that has since
 * changed is stale and is made again (the sweep for neutral summaries, the next reader's request for the rest).
 */

const { draftFromOutput } = require('../clients/ai');
const reviewKind = require('./review-kind');
const { checkCapability, CAPABILITIES } = require('../auth/capabilities');

const TONES = ['brief', 'neutral', 'explained'];
const TONE_TEXT = { brief: 'In brief', neutral: 'Summary', explained: 'Explained' };
const KINDS = ['summary', 'perspectives'];
const MIN_REPORTS = 2;
const SWEEP_PER_TICK = 6;
const SWEEP_WINDOW_MS = 72 * 3_600_000;

const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch { return d; } };

function createBriefs({ store, ai, log = console, minOutlets = 2 }) {
    const MIN_OUTLETS = Math.max(1, Number(minOutlets) || 2);
    const db = store.db;
    const q = {
        cluster: db.prepare("SELECT * FROM news_story_clusters WHERE id = ? AND status = 'open'"),
        reports: db.prepare("SELECT * FROM news_source_items WHERE cluster_id = ? AND status = 'active' AND removed_at IS NULL AND (published_at IS NULL OR published_at <= ?) ORDER BY published_at, first_seen_at, seq"),
        get: db.prepare('SELECT * FROM news_cluster_briefs WHERE cluster_id = ? AND kind = ? AND tone = ?'),
        put: db.prepare(`INSERT INTO news_cluster_briefs (cluster_id, kind, tone, headline, paragraphs, source_ids, gaps, run_id, model, stub, item_count, cluster_updated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (cluster_id, kind, tone) DO UPDATE SET headline = excluded.headline, paragraphs = excluded.paragraphs, source_ids = excluded.source_ids,
                gaps = excluded.gaps, run_id = excluded.run_id, model = excluded.model, stub = excluded.stub, item_count = excluded.item_count,
                cluster_updated_at = excluded.cluster_updated_at, created_at = excluded.created_at`),
        reviewLatest: db.prepare('SELECT * FROM news_brief_reviews WHERE cluster_id = ? AND kind = ? AND tone = ? ORDER BY id DESC LIMIT 1'),
        reviewByKind: db.prepare('SELECT DISTINCT ON (reviewer_kind) * FROM news_brief_reviews WHERE cluster_id = ? AND kind = ? AND tone = ? ORDER BY reviewer_kind, id DESC'),
        reviewInsert: db.prepare(`INSERT INTO news_brief_reviews (cluster_id, kind, tone, brief_created_at, reviewer, reviewer_kind, decision, note, reviewed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
        pending: db.prepare(`SELECT b.*, c.label, c.window_end, c.updated_at AS cluster_updated_at_now,
                (SELECT count(DISTINCT i.outlet) FROM news_source_items i WHERE i.cluster_id = c.id AND i.status = 'active' AND i.removed_at IS NULL) AS outlets,
                (SELECT count(*) FROM news_source_items i WHERE i.cluster_id = c.id AND i.status = 'active' AND i.removed_at IS NULL) AS item_count_now
            FROM news_cluster_briefs b JOIN news_story_clusters c ON c.id = b.cluster_id
            WHERE b.kind = 'summary' AND b.tone = 'neutral' AND b.stub = false AND c.status = 'open'
            ORDER BY b.created_at, b.cluster_id LIMIT 1000`),
        latest: db.prepare(`SELECT * FROM (SELECT b.*, c.label, c.window_end,
                (SELECT count(DISTINCT i.outlet) FROM news_source_items i WHERE i.cluster_id = c.id AND i.status = 'active' AND i.removed_at IS NULL) AS outlets
              FROM news_cluster_briefs b JOIN news_story_clusters c ON c.id = b.cluster_id
             WHERE b.kind = 'summary' AND b.tone = 'neutral' AND b.stub = false AND c.status = 'open') x
            WHERE x.outlets >= ? ORDER BY x.window_end DESC, x.created_at DESC LIMIT ?`),
        // Open clusters active in the window with at least MIN_REPORTS live reports, newest activity first.
        due: db.prepare(`SELECT c.id, c.updated_at, count(i.id) AS n FROM news_story_clusters c JOIN news_source_items i ON i.cluster_id = c.id AND i.status = 'active' AND i.removed_at IS NULL AND (i.published_at IS NULL OR i.published_at <= ?)
            WHERE c.status = 'open' AND c.window_end >= ? GROUP BY c.id, c.updated_at, c.window_end HAVING count(i.id) >= ? AND count(DISTINCT i.outlet) >= ? ORDER BY c.window_end DESC LIMIT 200`),
    };

    const fresh = (row, cluster, n) => Boolean(row && Number(row.item_count) === n && Number(row.cluster_updated_at) === Number(cluster.updated_at));

    /** The stored brief, and whether it still matches its cluster. */
    async function get(clusterId, { kind = 'summary', tone = 'neutral' } = {}) {
        const cluster = await q.cluster.get(clusterId);
        if (!cluster) return null;
        const cutoff = new Date(store.now() + 24 * 3_600_000).toISOString();
        const reports = await q.reports.all(cluster.id, cutoff);
        const row = await q.get.get(cluster.id, kind, tone);
        const outlets = new Set(reports.map((r) => r.outlet)).size;
        return { cluster, reports, brief: row ? shape(row) : null, fresh: fresh(row, cluster, reports.length), outlets, enough: outlets >= MIN_OUTLETS, minOutlets: MIN_OUTLETS };
    }

    function shape(row) {
        return {
            cluster_id: row.cluster_id, kind: row.kind, tone: row.tone, headline: row.headline || null,
            paragraphs: parse(row.paragraphs, []), source_ids: parse(row.source_ids, []), gaps: parse(row.gaps, []),
            run_id: row.run_id || null, model: row.model || null, stub: Boolean(row.stub), item_count: Number(row.item_count), created_at: Number(row.created_at),
        };
    }

    const reviewShape = (r) => (r ? { id: Number(r.id), clusterId: r.cluster_id, kind: r.kind, tone: r.tone, briefCreatedAt: Number(r.brief_created_at), reviewer: r.reviewer, reviewerKind: r.reviewer_kind === reviewKind.AI_EDITOR ? reviewKind.AI_EDITOR : reviewKind.PERSON, decision: r.decision, note: r.note, reviewedAt: Number(r.reviewed_at) } : null);

    /**
     * The AI editor records a review as itself: a first-party service principal (svc:…) with no
     * person named, holding news.review.ai_editor. A service acting for a person is that person.
     */
    function isAiEditor(viewer) {
        if (!viewer || viewer.kind !== 'service' || viewer.subject || !/^svc:/.test(String(viewer.service))) return false;
        return checkCapability(viewer.claims, CAPABILITIES.REVIEW_AI_EDITOR).allowed;
    }

    /** The latest review of one brief (any decision), or null. */
    async function reviewOf(clusterId, { kind = 'summary', tone = 'neutral' } = {}) {
        return reviewShape(await q.reviewLatest.get(clusterId, kind, tone));
    }

    /** The review of each kind for one brief: { person, ai_editor }. */
    async function reviewsOf(clusterId, { kind = 'summary', tone = 'neutral' } = {}) {
        const out = { person: null, ai_editor: null };
        for (const row of await q.reviewByKind.all(clusterId, kind, tone)) {
            out[row.reviewer_kind === reviewKind.AI_EDITOR ? reviewKind.AI_EDITOR : reviewKind.PERSON] = reviewShape(row);
        }
        return out;
    }

    /** An approval counts only for the exact brief it reviewed (a remake changes created_at). */
    function isApproved(brief, review) {
        return Boolean(brief && review && review.decision === 'approved' && Number(review.briefCreatedAt) === Number(brief.created_at));
    }

    /**
     * A review of a brief: a signed-in person's, or the AI editor's (a svc:… principal acting as
     * itself with news.review.ai_editor). The review log is the audit.
     */
    async function review(viewer, clusterId, { kind = 'summary', tone = 'neutral', decision, note = null } = {}) {
        const aiEditor = isAiEditor(viewer);
        if (!aiEditor && (!viewer || viewer.kind !== 'user' || !viewer.subject)) throw Object.assign(new Error('Only a signed-in person (or the AI editor) can review a brief'), { code: 'review.person_required', status: 403 });
        if (!KINDS.includes(kind) || !TONES.includes(tone)) throw Object.assign(new Error('kind or tone not known'), { code: 'brief.invalid', status: 422 });
        if (decision !== 'approved' && decision !== 'rejected') throw Object.assign(new Error('decision is approved or rejected'), { code: 'review.invalid_decision', status: 422 });
        const got = await get(clusterId, { kind, tone });
        if (!got || !got.brief) throw Object.assign(new Error('No such brief'), { code: 'brief.not_found', status: 404 });
        if (got.brief.stub || !got.enough) throw Object.assign(new Error('This brief is not shown to readers'), { code: 'brief.not_public', status: 422 });
        const row = await q.reviewInsert.get(String(clusterId), kind, tone, Number(got.brief.created_at),
            aiEditor ? viewer.service : viewer.subject, aiEditor ? reviewKind.AI_EDITOR : reviewKind.PERSON,
            decision, note == null ? null : String(note).slice(0, 2000), store.now());
        return reviewShape(row);
    }

    /**
     * Every current brief nobody has reviewed yet, oldest first: what the reviewer queue lists. An
     * ai_editor decision is named in `reviewed`: its approval publishes and indexes the brief and
     * leaves the queue; its rejection stays until a person decides.
     */
    async function pendingReviews() {
        const items = [];
        for (const row of await q.pending.all()) {
            if (Number(row.outlets) < MIN_OUTLETS) continue;
            if (Number(row.item_count) !== Number(row.item_count_now) || Number(row.cluster_updated_at) !== Number(row.cluster_updated_at_now)) continue;
            const brief = shape(row);
            const kinds = await reviewsOf(row.cluster_id);
            const forThisText = (r) => Boolean(r && Number(r.briefCreatedAt) === Number(brief.created_at));
            if (forThisText(kinds.person)) continue;   // a person's decision, approved or rejected, for this exact text
            const ai = forThisText(kinds.ai_editor) ? kinds.ai_editor : null;
            if (ai && ai.decision === 'approved') continue;   // the AI editor approved it: published and indexable
            items.push({
                site: 'news', kind: 'ai_brief', id: row.cluster_id,
                title: brief.headline || row.label, revision: null,
                url: `/briefs/${row.cluster_id}`,
                createdAt: new Date(brief.created_at).toISOString(),
                reasons: [
                    { code: 'ai_generated_unreviewed', effect: 'noindex', detail: 'a person has not reviewed this brief', text: 'AI-written and not reviewed by a person.' },
                    { code: 'noindex_requested', effect: 'noindex', detail: 'briefs are noindex until reviewed', text: 'An editor asked for it to stay out of search engines until a person reviews it.' },
                ],
                reviewed: ai ? { kind: reviewKind.AI_EDITOR, decision: ai.decision, by: ai.reviewer, at: ai.reviewedAt, label: reviewKind.aiEditorVerdict(ai) } : null,
                review: { method: 'POST', path: `/api/v1/briefs/${encodeURIComponent(row.cluster_id)}/reviews` },
            });
        }
        return items;
    }

    /** Reviewed briefs that still match their review, newest review first, for the sitemap. */
    async function reviewed(limit = 1000) {
        const out = [];
        for (const row of await q.pending.all()) {
            if (Number(row.outlets) < MIN_OUTLETS) continue;
            if (Number(row.item_count) !== Number(row.item_count_now) || Number(row.cluster_updated_at) !== Number(row.cluster_updated_at_now)) continue;
            const brief = shape(row);
            const review = await reviewOf(row.cluster_id);
            if (!isApproved(brief, review)) continue;
            out.push({ ...brief, label: row.label, window_end: Number(row.window_end), review });
            if (out.length >= limit) break;
        }
        return out.sort((a, b) => b.review.reviewedAt - a.review.reviewedAt);
    }

    /** Make (or remake) one brief. Throws the AI client's error when the run fails; makes nothing without cited text. */
    async function make(clusterId, { kind = 'summary', tone = 'neutral' } = {}) {
        if (!ai || !ai.enabled) throw Object.assign(new Error('OpenVibe.AI is not configured on this server'), { code: 'ai.not_configured', status: 503 });
        if (!KINDS.includes(kind) || !TONES.includes(tone)) throw Object.assign(new Error('kind or tone not known'), { code: 'brief.invalid', status: 422 });
        const cluster = await q.cluster.get(clusterId);
        if (!cluster) throw Object.assign(new Error('No such cluster'), { code: 'cluster.not_found', status: 404 });
        const cutoff = new Date(store.now() + 24 * 3_600_000).toISOString();
        const reports = await q.reports.all(cluster.id, cutoff);
        if (!reports.length) throw Object.assign(new Error('This cluster has no live reports'), { code: 'brief.no_reports', status: 422 });
        const outlets = new Set(reports.map((r) => r.outlet));
        if (kind === 'summary' && outlets.size < MIN_OUTLETS) throw Object.assign(new Error(`Only ${outlets.size === 1 ? 'one outlet has' : `${outlets.size} outlets have`} reported this; a summary needs ${MIN_OUTLETS}`), { code: 'brief.too_few_outlets', status: 422 });
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
        const cutoff = new Date(store.now() + 24 * 3_600_000).toISOString();
        for (const c of await q.due.all(cutoff, store.now() - SWEEP_WINDOW_MS, MIN_REPORTS, MIN_OUTLETS)) {
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

    const latest = async (limit = 12) => (await q.latest.all(MIN_OUTLETS, limit)).map((r) => ({ ...shape(r), label: r.label, window_end: Number(r.window_end), outlets: Number(r.outlets) }));

    return { TONES, TONE_TEXT, KINDS, MIN_REPORTS, MIN_OUTLETS, get, make, sweep, latest, review, reviewOf, reviewsOf, isApproved, pendingReviews, reviewed };
}

module.exports = { createBriefs, TONES, TONE_TEXT, MIN_REPORTS };
