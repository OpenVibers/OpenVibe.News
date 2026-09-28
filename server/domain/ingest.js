'use strict';

/**
 * Ingestion: OpenVibe.Sources items (category news) → news_source_items → dedupe → clusters.
 *
 * Two ways in, one effect:
 *   - the Events webhook (sources.item.created|updated|removed, sources.fetch.failed), each event
 *     applied once through the inbox (http/webhook.js);
 *   - the cursor pull (worker), the backstop for missed deliveries: GET /api/v1/items in change
 *     order from the stored cursor.
 * apply() is idempotent on (Sources item id, Sources revision): a replay, or the same item arriving
 * by both paths, changes nothing and emits nothing.
 *
 * What is stored (licensing): headline, canonical URL, outlet, authors, published_at, the licence
 * and terms notes, and a short summary ONLY when those notes explicitly allow short summaries
 * (text.licensedSummary). Every other field of the Sources item — whatever an adapter mapped into
 * `fields` — is ignored, so an article body can never be stored, shown, fed or indexed.
 *
 * Failure is a recorded state (news_ingest_runs + news.source.failed), never a replacement: a
 * failed fetch or an unreadable item creates no source item, no cluster and no story text.
 *
 * Upstream changes to an item a story cites (a revision, a removal) go to stories.onUpstreamChange,
 * which flags the story and prepares a pending revision; published text is never changed silently.
 * A removal can also hide the story's Community thread (domain/discussion.js, after the commit).
 */
const { ids } = require('openvibe-contracts');
const text = require('./text');

const NEAR_TITLE = { anyOutlet: 0.9, sameOutlet: 0.75, windowMs: 48 * 3600 * 1000 };
const newItemId = (now) => `nsi_${ids.ulid(now)}`;

function createIngest({ store, config, clusters, outbox, sources, discussion = null, log = console }) {
    const { db } = store;
    let stories = null;   // set by app.js (stories depend on ingest's items too)
    const q = {
        bySourcesId: db.prepare('SELECT * FROM news_source_items WHERE sources_item_id = ?'),
        byId: db.prepare('SELECT * FROM news_source_items WHERE id = ?'),
        byUrl: db.prepare("SELECT * FROM news_source_items WHERE url_key = ? AND status <> 'removed' ORDER BY first_seen_at, seq LIMIT 1"),
        byHash: db.prepare("SELECT * FROM news_source_items WHERE content_hash = ? AND status <> 'removed' ORDER BY first_seen_at, seq LIMIT 1"),
        recent: db.prepare("SELECT * FROM news_source_items WHERE status <> 'removed' AND first_seen_at >= ? ORDER BY first_seen_at, seq"),
        status: db.prepare('SELECT * FROM news_source_status WHERE source_key = ?'),
        putStatus: db.prepare(`INSERT INTO news_source_status (source_key, name, homepage_url, status, stale, last_success_at, refreshed_at)
                               VALUES (@source_key, @name, @homepage_url, @status, @stale, @last_success_at, @now)
                               ON CONFLICT (source_key) DO UPDATE SET name = COALESCE(excluded.name, news_source_status.name), homepage_url = COALESCE(excluded.homepage_url, news_source_status.homepage_url),
                               status = COALESCE(excluded.status, news_source_status.status), stale = COALESCE(excluded.stale, news_source_status.stale),
                               last_success_at = COALESCE(excluded.last_success_at, news_source_status.last_success_at), refreshed_at = excluded.refreshed_at`),
        run: db.prepare(`INSERT INTO news_ingest_runs (origin, state, source_key, sources_item_id, error_code, detail, counts, cursor_before, cursor_after, at)
                         VALUES (@origin, @state, @source_key, @sources_item_id, @error_code, @detail, @counts, @cursor_before, @cursor_after, @at)`),
        lastPull: db.prepare("SELECT * FROM news_ingest_runs WHERE origin = 'pull' ORDER BY id DESC LIMIT 1"),
    };

    async function recordRun(r) {
        await q.run.run({ source_key: null, sources_item_id: null, error_code: null, detail: null, counts: null, cursor_before: null, cursor_after: null, ...r, counts: r.counts ? JSON.stringify(r.counts) : null, at: store.now() });
    }

    async function failedEvent({ origin, sourceKey = null, sourcesItemId = null, state, errorCode = null, detail = null, httpStatus = null, extra = {} }) {
        await outbox.emit({
            event_type: 'news.source.failed', actor: { type: 'service', id: 'news' }, visibility: 'internal', priority: 'important',
            subject: sourceKey ? { type: 'source', id: sourceKey } : { type: 'ingest', id: origin },
            payload: { origin, source_key: sourceKey, sources_item_id: sourcesItemId, state, error_code: errorCode, http_status: httpStatus, detail: detail ? String(detail).slice(0, 500) : null, ...extra },
        });
    }

    async function outletFor(item) {
        const st = await q.status.get(item.source_key);
        return (st && st.name) || text.hostOf(item.canonical_url) || item.source_key;
    }

    /** The fields News keeps from a Sources item. Nothing else of the item is read. */
    async function normalise(item) {
        const prov = item.provenance || {};
        const headline = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        const lic = text.licensedSummary(item.summary, { termsNote: prov.terms_note, licenseNote: prov.license_note, maxChars: config.licensing.summaryMaxChars });
        const authors = Array.isArray(item.authors) ? item.authors.map((a) => String(a || '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 10) : [];
        const published = item.published_at && Number.isFinite(Date.parse(item.published_at)) ? new Date(Date.parse(item.published_at)).toISOString() : null;
        return {
            headline,
            canonical_url: item.canonical_url || null,
            url_key: text.urlKey(item.canonical_url),
            outlet: await outletFor(item),
            authors: JSON.stringify(authors),
            published_at: published,
            summary: lic.summary,
            summary_basis: lic.basis,
            license_note: prov.license_note ? String(prov.license_note).slice(0, 2000) : null,
            terms_note: prov.terms_note ? String(prov.terms_note).slice(0, 2000) : null,
            content_hash: prov.content_hash || null,
            title_key: text.titleKey(headline),
            retrieved_at: prov.retrieved_at || null,
        };
    }

    /** Is this new item a duplicate of one we have? → null | { of, rule, detail } */
    async function dedupe(n, sourceKey, at) {
        if (n.url_key) {
            const hit = await q.byUrl.get(n.url_key);
            if (hit) return { of: hit.duplicate_of || hit.id, rule: 'canonical_url', detail: n.url_key };
        }
        if (n.content_hash) {
            const hit = await q.byHash.get(n.content_hash);
            if (hit) return { of: hit.duplicate_of || hit.id, rule: 'content_hash', detail: n.content_hash };
        }
        const mine = text.shingles(n.headline);
        const host = text.hostOf(n.canonical_url);
        let best = null;
        for (const c of await q.recent.all(Math.min(at, store.now()) - NEAR_TITLE.windowMs)) {
            const t = clusters.itemTime(c);
            if (Math.abs(t - at) > NEAR_TITLE.windowMs) continue;
            const score = text.jaccard(mine, text.shingles(c.headline));
            const sameOutlet = c.source_key === sourceKey || (host && text.hostOf(c.canonical_url) === host);
            const threshold = sameOutlet ? NEAR_TITLE.sameOutlet : NEAR_TITLE.anyOutlet;
            if (score >= threshold && (!best || score > best.score)) best = { c, score, sameOutlet };
        }
        if (best) return { of: best.c.duplicate_of || best.c.id, rule: 'near_title', detail: `jaccard ${best.score.toFixed(2)} of headline 2-shingles${best.sameOutlet ? ' (same outlet)' : ''}` };
        return null;
    }

    async function ingestedEvent(row, action, extra = {}) {
        await outbox.emit({
            event_type: 'news.source.ingested', actor: { type: 'service', id: 'news' }, visibility: 'internal', priority: 'low',
            subject: { type: 'source_item', id: row.id },
            payload: {
                item_id: row.id, action, status: row.status,
                sources_item: { service: 'sources', type: 'item', id: row.sources_item_id, revision: row.sources_revision },
                source_key: row.source_key, canonical_url: row.canonical_url, duplicate_of: row.duplicate_of,
                dedupe_rule: row.dedupe ? JSON.parse(row.dedupe).rule : null, cluster_id: row.cluster_id, ...extra,
            },
        });
    }

    /**
     * Apply one Sources item (inside a transaction the caller may already hold). Returns
     * { outcome: created|updated|removed|unchanged|ignored|rejected, item?, reason? }.
     */
    async function apply(item, { origin = 'pull' } = {}) {
        return db.tx(async () => {
            if (!item || typeof item.id !== 'string') return { outcome: 'rejected', reason: 'item without id' };
            if (item.category && item.category !== config.sources.category) return { outcome: 'ignored', reason: `category ${item.category}` };
            const revision = Number.isInteger(item.revision) ? item.revision : 1;
            const cur = await q.bySourcesId.get(item.id);
            if (item.removed) return applyRemoval({ sourcesItemId: item.id, reason: item.removed.reason || 'removed upstream', revision, origin });
            if (cur && cur.sources_revision >= revision) return { outcome: 'unchanged', item: cur };
            const n = await normalise(item);
            if (!n.headline) {
                await recordRun({ origin, state: 'rejected', source_key: item.source_key || null, sources_item_id: item.id, error_code: 'item.no_headline', detail: 'a Sources item without a title cannot be shown' });
                await failedEvent({ origin, sourceKey: item.source_key || null, sourcesItemId: item.id, state: 'rejected', errorCode: 'item.no_headline' });
                return { outcome: 'rejected', reason: 'no headline' };
            }
            const now = store.now();
            if (cur) {
                if (cur.status === 'removed') return { outcome: 'unchanged', item: cur };   // removal is sticky here too
                await db.prepare(`UPDATE news_source_items SET sources_revision = @rev, canonical_url = @canonical_url, url_key = @url_key, headline = @headline,
                            outlet = @outlet, authors = @authors, published_at = @published_at, summary = @summary, summary_basis = @summary_basis,
                            license_note = @license_note, terms_note = @terms_note, content_hash = @content_hash, title_key = @title_key,
                            retrieved_at = @retrieved_at, upstream_updated_at = @now, updated_at = @now WHERE id = @id`)
                    .run({ ...n, rev: revision, now, id: cur.id });
                const row = await q.byId.get(cur.id);
                if (row.cluster_id) await clusters.recompute((await clusters.resolve(row.cluster_id)).id);
                await ingestedEvent(row, 'updated', { previous_revision: cur.sources_revision });
                const affected = stories ? await stories.onUpstreamChange(row, 'source_updated', { previous: cur }) : [];
                return { outcome: 'updated', item: row, stories: affected };
            }
            const at = (() => { const p = n.published_at ? Date.parse(n.published_at) : NaN; return Number.isFinite(p) ? p : now; })();
            const dup = await dedupe(n, item.source_key, at);
            const id = newItemId(now);
            await db.prepare(`INSERT INTO news_source_items (id, sources_item_id, sources_revision, source_key, canonical_url, url_key, headline, outlet, authors,
                        published_at, summary, summary_basis, license_note, terms_note, content_hash, title_key, status, duplicate_of, dedupe,
                        retrieved_at, first_seen_at, updated_at)
                        VALUES (@id, @sources_item_id, @rev, @source_key, @canonical_url, @url_key, @headline, @outlet, @authors,
                        @published_at, @summary, @summary_basis, @license_note, @terms_note, @content_hash, @title_key, @status, @duplicate_of, @dedupe,
                        @retrieved_at, @now, @now)`)
                .run({ ...n, id, sources_item_id: item.id, rev: revision, source_key: String(item.source_key || 'unknown'),
                    status: dup ? 'duplicate' : 'active', duplicate_of: dup ? dup.of : null, dedupe: dup ? JSON.stringify({ rule: dup.rule, detail: dup.detail }) : null, now });
            await clusters.assign(await q.byId.get(id));
            const row = await q.byId.get(id);
            await ingestedEvent(row, 'created');
            return { outcome: 'created', item: row };
        });
    }

    /** A Sources removal (takedown, licence, error): sticky; the stored summary is dropped. */
    async function applyRemoval({ sourcesItemId, reason, revision = null, origin = 'webhook' }) {
        return db.tx(async () => {
            const cur = await q.bySourcesId.get(sourcesItemId);
            if (!cur) return { outcome: 'ignored', reason: 'never ingested' };
            if (cur.status === 'removed') return { outcome: 'unchanged', item: cur };
            // A story resting on it may stop being open for comments (domain/discussion.js).
            if (discussion) await discussion.watchSource(cur.id);
            const now = store.now();
            await db.prepare(`UPDATE news_source_items SET status = 'removed', summary = NULL, summary_basis = 'removed_upstream', removed_at = ?, removed_reason = ?,
                        sources_revision = GREATEST(sources_revision, COALESCE(?, sources_revision)), updated_at = ? WHERE id = ?`)
                .run(now, String(reason || 'removed upstream').slice(0, 500), revision, now, cur.id);
            const row = await q.byId.get(cur.id);
            if (row.cluster_id) await clusters.recompute((await clusters.resolve(row.cluster_id)).id);
            await ingestedEvent(row, 'removed', { reason: row.removed_reason, origin });
            const affected = stories ? await stories.onUpstreamChange(row, 'source_removed', { previous: cur }) : [];
            return { outcome: 'removed', item: row, stories: affected };
        });
    }

    /** sources.fetch.failed for a news source: recorded and relayed; nothing else changes. */
    async function upstreamFailure(payload) {
        return db.tx(async () => {
            if (payload.category && payload.category !== config.sources.category) return { outcome: 'ignored' };
            await recordRun({ origin: 'sources', state: String(payload.state || 'failed').slice(0, 40), source_key: payload.source_key || null, error_code: payload.error_code || null,
                detail: `run ${payload.run_id || '?'}${payload.http_status ? ` HTTP ${payload.http_status}` : ''}${payload.consecutive_failures ? `, ${payload.consecutive_failures} consecutive failures` : ''}` });
            await q.putStatus.run({ source_key: payload.source_key || 'unknown', name: null, homepage_url: null, status: 'failing', stale: null, last_success_at: null, now: store.now() });
            await failedEvent({ origin: 'sources', sourceKey: payload.source_key || null, state: payload.state || 'failed', errorCode: payload.error_code || null, httpStatus: payload.http_status || null,
                extra: { run_id: payload.run_id || null, consecutive_failures: payload.consecutive_failures || null } });
            return { outcome: 'recorded' };
        });
    }

    /** Remember what a Sources page says about its sources' health (display only). */
    async function rememberSources(map) {
        for (const [key, h] of Object.entries(map || {})) {
            await q.putStatus.run({ source_key: key, name: null, homepage_url: null, status: h.status || null, stale: h.stale == null ? null : (h.stale ? 1 : 0), last_success_at: h.last_success_at || null, now: store.now() });
        }
    }

    /** Fetch registry names we do not know yet (needs sources.source.read; failure = keep the host name). */
    async function learnOutlets(keys) {
        for (const key of [...new Set(keys)]) {
            const st = await q.status.get(key);
            if (st && st.name) continue;
            try {
                const s = await sources.getSource(key);
                await q.putStatus.run({ source_key: key, name: s && s.name ? String(s.name).slice(0, 200) : null, homepage_url: s && s.homepage_url ? String(s.homepage_url) : null,
                    status: s && s.health ? s.health.status || null : null, stale: s && s.health && s.health.stale != null ? (s.health.stale ? 1 : 0) : null,
                    last_success_at: s && s.health ? s.health.last_success_at || null : null, now: store.now() });
            } catch { /* optional grant; the outlet stays the URL's host */ }
        }
    }

    /**
     * The cursor pull. Reads pages from the stored cursor until Sources says there is no more (or
     * the page budget is spent), applying each item. The cursor moves only past applied pages.
     */
    let pulling = null;
    async function pull() {
        if (pulling) return pulling;
        pulling = (async () => {
            const before = await store.getState('sources_cursor', 0);
            let after = before;
            const counts = { created: 0, updated: 0, removed: 0, unchanged: 0, ignored: 0, rejected: 0, duplicates: 0 };
            try {
                for (let page = 0; page < config.sources.maxPagesPerRun; page++) {
                    const body = await sources.listItems({ after, limit: config.sources.pageSize });
                    await rememberSources(body.sources);
                    await learnOutlets(body.items.map((i) => i.source_key).filter(Boolean));
                    await store.tx(async () => {
                        for (const item of body.items) {
                            const r = await apply(item, { origin: 'pull' });
                            counts[r.outcome] = (counts[r.outcome] || 0) + 1;
                            if (r.outcome === 'created' && r.item.status === 'duplicate') counts.duplicates++;
                        }
                        await store.setState('sources_cursor', body.next_after);
                    });
                    after = body.next_after;
                    if (!body.more) break;
                }
                await store.tx(async () => await recordRun({ origin: 'pull', state: 'ok', counts, cursor_before: before, cursor_after: after }));
                return { ok: true, counts, cursor: after };
            } catch (err) {
                const prev = await q.lastPull.get();
                await store.tx(async () => {
                    await recordRun({ origin: 'pull', state: 'failed', error_code: err.code || 'pull.error', detail: err.message, counts, cursor_before: before, cursor_after: after });
                    // One event per outage, not one per retry.
                    if (!prev || prev.state !== 'failed') await failedEvent({ origin: 'pull', state: 'failed', errorCode: err.code || 'pull.error', detail: err.message, httpStatus: err.status || null });
                });
                log.warn(`[News] Sources pull failed (${err.code || 'error'}): ${err.message}`);
                return { ok: false, error: err.code || 'pull.error', detail: err.message, counts, cursor: after };
            } finally { pulling = null; }
        })();
        return pulling;
    }

    return {
        NEAR_TITLE,
        setStories(s) { stories = s; },
        normalise, dedupe, apply, applyRemoval, upstreamFailure, pull, recordRun, failedEvent, learnOutlets, rememberSources,
        get: async (id) => await q.byId.get(String(id || '')) || null,
        bySourcesId: async (id) => await q.bySourcesId.get(String(id || '')) || null,
        runs: async ({ limit = 30 } = {}) => await db.prepare('SELECT * FROM news_ingest_runs ORDER BY id DESC LIMIT ?').all(limit),
        sourceStatus: async () => await db.prepare('SELECT * FROM news_source_status ORDER BY source_key').all(),
        lastPull: async () => await q.lastPull.get() || null,
    };
}

module.exports = { createIngest, NEAR_TITLE };
