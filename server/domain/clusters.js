'use strict';

/**
 * Clusters: deterministic, explainable grouping of source items that report the same story.
 *
 *   assign(item)   an active item joins the open cluster it shares the most with inside the time
 *                  window (NEWS_CLUSTER_WINDOW_HOURS, default 72 h), matched on the cluster's core only: the
 *                  entities and terms about a third of its reports carry (coreMin), so a big cluster cannot
 *                  snowball on the union of everything it holds;
 *                    shared named entities count 2, shared terms count 1;
 *                    it joins when (≥ 1 shared entity AND ≥ 2 shared terms) OR ≥ 3 shared terms;
 *                    ties go to the oldest cluster. Otherwise it starts a new cluster.
 *                  The decision is stored on the item (cluster_reason) with the shared entities,
 *                  shared terms and score, so every membership can be explained and recomputed.
 *                  A duplicate joins its original's cluster (rule "duplicate_of").
 *   merge(a, b)    an editor merges b into a; split(a, items) moves items into a new cluster.
 *   resplit(a)     regroups a cluster's reports with today's rule; every group but the first report's is split
 *                  off (audited and reversible, like an editor's split).
 *                  Both are audited (news_cluster_audit, with exactly which items moved) and
 *                  reversible (reverse(auditId)); nothing is deleted.
 *
 * Every change emits news.cluster.updated (internal) in the same transaction.
 */
const { ids } = require('openvibe-contracts');
const { normalize } = require('openvibe-publishing/ingest');
const { ApiError } = require('../http/errors');

const newClusterId = (now) => `clu_${ids.ulid(now)}`;
const newAuditId = (now) => `cla_${ids.ulid(now)}`;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Terms and entities of one item (headline + the licensed summary we store). */
function signature(item) {
    const t = `${item.headline || ''}. ${item.summary || ''}`;
    return { terms: normalize.terms(t), entities: normalize.entities(item.headline || '').concat(normalize.entities(item.summary || '')).filter((v, i, a) => a.indexOf(v) === i).sort() };
}

/** The time an item is placed at: when the source says it was published, else when News first saw it. */
function itemTime(item) {
    const p = item.published_at ? Date.parse(item.published_at) : NaN;
    return Number.isFinite(p) ? p : item.first_seen_at;
}

/**
 * How many of a cluster's n reports must carry an entity or term for it to be the story's own: about a third (one
 * report of one or two, two of three to five, 66 of 196). Matching on the union instead let one cluster take 196
 * unrelated reports from three outlets (2026-10-15: 1,950 terms, so nearly any report shared three).
 */
const coreMin = (n) => Math.ceil((Math.max(1, n) + 1) / 3);

/** Match an item's signature against a cluster's core (n = its reports). → { sharedEntities, sharedTerms, score, joins, coreMin } */
function compare(sig, cluster, n = 1) {
    const ce = typeof cluster.entities === 'string' ? parse(cluster.entities, {}) : cluster.entities || {};
    const ct = typeof cluster.terms === 'string' ? parse(cluster.terms, {}) : cluster.terms || {};
    const min = coreMin(n);
    const sharedEntities = sig.entities.filter((e) => (ce[e] || 0) >= min);
    const sharedTerms = sig.terms.filter((t) => (ct[t] || 0) >= min);
    const score = 2 * sharedEntities.length + sharedTerms.length;
    const joins = (sharedEntities.length >= 1 && sharedTerms.length >= 2) || sharedTerms.length >= 3;
    return { sharedEntities, sharedTerms, score, joins, coreMin: min };
}

function labelOf(entities, terms) {
    const top = (obj) => Object.entries(obj).sort(([a, x], [b, y]) => (y - x) || (a < b ? -1 : 1)).map(([k]) => k);
    const e = top(entities).slice(0, 3);
    const words = e.length ? e : top(terms).slice(0, 4);
    return words.length ? words.join(' · ') : 'unlabelled';
}

function createClusters({ store, config, outbox }) {
    const { db } = store;
    const q = {
        get: db.prepare('SELECT * FROM news_story_clusters WHERE id = ?'),
        open: db.prepare(`SELECT * FROM news_story_clusters WHERE status = 'open' AND window_end >= ? AND window_start <= ? ORDER BY created_at, seq`),
        insert: db.prepare(`INSERT INTO news_story_clusters (id, label, status, split_from, terms, entities, window_start, window_end, created_by, created_at, updated_at)
                            VALUES (@id, @label, 'open', @split_from, @terms, @entities, @window_start, @window_end, @created_by, @now, @now)`),
        members: db.prepare("SELECT * FROM news_source_items WHERE cluster_id = ? ORDER BY first_seen_at, seq"),
        sizes: db.prepare("SELECT cluster_id, count(*) AS n FROM news_source_items WHERE cluster_id = ANY(?) AND status <> 'removed' GROUP BY cluster_id"),
        setItem: db.prepare('UPDATE news_source_items SET cluster_id = ?, cluster_reason = ?, updated_at = ? WHERE id = ?'),
        audit: db.prepare('SELECT * FROM news_cluster_audit WHERE id = ?'),
        auditFor: db.prepare('SELECT * FROM news_cluster_audit WHERE cluster_id = ? OR other_id = ? ORDER BY created_at, seq'),
        insertAudit: db.prepare(`INSERT INTO news_cluster_audit (id, action, cluster_id, other_id, item_ids, reason, actor, reverses, created_at)
                                 VALUES (@id, @action, @cluster_id, @other_id, @item_ids, @reason, @actor, @reverses, @now)`),
    };

    async function emit(cluster, action, extra = {}) {
        await outbox.emit({
            event_type: 'news.cluster.updated', actor: { type: 'service', id: 'news' }, visibility: 'internal', priority: 'low',
            subject: { type: 'cluster', id: cluster.id },
            payload: { cluster_id: cluster.id, action, status: cluster.status, label: cluster.label, item_count: (await q.members.all(cluster.id)).length, ...extra },
        });
    }

    /** Rebuild a cluster's terms, entities, window and label from its members (removed items do not count). */
    async function recompute(clusterId) {
        const terms = {};
        const entities = {};
        let start = null;
        let end = null;
        for (const it of await q.members.all(clusterId)) {
            if (it.status === 'removed') continue;
            const sig = signature(it);
            for (const t of sig.terms) terms[t] = (terms[t] || 0) + 1;
            for (const e of sig.entities) entities[e] = (entities[e] || 0) + 1;
            const at = itemTime(it);
            start = start == null ? at : Math.min(start, at);
            end = end == null ? at : Math.max(end, at);
        }
        await db.prepare('UPDATE news_story_clusters SET terms = ?, entities = ?, window_start = COALESCE(?, window_start), window_end = COALESCE(?, window_end), label = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(terms), JSON.stringify(entities), start, end, labelOf(entities, terms), store.now(), clusterId);
        return await q.get.get(clusterId);
    }

    /**
     * Place one item (inside the ingest transaction). Duplicates follow their original. Returns
     * { cluster, created, reason }.
     */
    async function assign(item) {
        if (item.status === 'duplicate' && item.duplicate_of) {
            const original = await db.prepare('SELECT * FROM news_source_items WHERE id = ?').get(item.duplicate_of);
            if (original && original.cluster_id) {
                const cluster = await resolve(original.cluster_id);
                const reason = { rule: 'duplicate_of', item: original.id };
                await q.setItem.run(cluster.id, JSON.stringify(reason), store.now(), item.id);
                await emit(cluster, 'item_added', { item_id: item.id, rule: 'duplicate_of' });
                return { cluster, created: false, reason };
            }
        }
        const sig = signature(item);
        const at = itemTime(item);
        const w = config.clustering.windowMs;
        let best = null;
        const open = await q.open.all(at - w, at + w);
        const sizes = new Map(open.length ? (await q.sizes.all(open.map((c) => c.id))).map((r) => [r.cluster_id, Number(r.n)]) : []);
        for (const c of open) {
            const m = compare(sig, c, sizes.get(c.id) || 1);
            if (!m.joins) continue;
            if (!best || m.score > best.m.score) best = { c, m, n: sizes.get(c.id) || 1 };   // ORDER BY created_at, seq: the oldest wins a tie
        }
        if (best) {
            const reason = { rule: 'shared_terms', cluster: best.c.id, shared_entities: best.m.sharedEntities, shared_terms: best.m.sharedTerms, score: best.m.score, core_min: best.m.coreMin, cluster_size: best.n, window_hours: w / 3600000 };
            await q.setItem.run(best.c.id, JSON.stringify(reason), store.now(), item.id);
            const cluster = await recompute(best.c.id);
            await emit(cluster, 'item_added', { item_id: item.id, rule: 'shared_terms', score: best.m.score });
            return { cluster, created: false, reason };
        }
        const now = store.now();
        const id = newClusterId(now);
        await q.insert.run({ id, label: 'new', split_from: null, terms: '{}', entities: '{}', window_start: at, window_end: at, created_by: 'svc:news', now });
        const reason = { rule: 'new_cluster', cluster: id, terms: sig.terms.slice(0, 20), entities: sig.entities.slice(0, 10) };
        await q.setItem.run(id, JSON.stringify(reason), now, item.id);
        const cluster = await recompute(id);
        await emit(cluster, 'created', { item_id: item.id });
        return { cluster, created: true, reason };
    }

    /** Follow merges to the cluster that holds the items now. */
    async function resolve(id) {
        let c = await q.get.get(id);
        for (let i = 0; c && c.status === 'merged' && c.merged_into && i < 50; i++) c = await q.get.get(c.merged_into);
        return c;
    }

    async function mustOpen(id) {
        const c = await q.get.get(String(id || ''));
        if (!c) throw new ApiError(404, 'cluster.not_found', 'No such cluster');
        if (c.status !== 'open') throw new ApiError(409, 'cluster.not_open', `Cluster ${c.id} is ${c.status}`);
        return c;
    }

    function actorId(viewer) { return viewer && viewer.subject ? viewer.subject : (viewer && viewer.service) || 'svc:news'; }

    async function recordAudit(row) {
        const now = store.now();
        const id = newAuditId(now);
        await q.insertAudit.run({ id, reason: null, reverses: null, ...row, item_ids: JSON.stringify(row.item_ids), now });
        return await q.audit.get(id);
    }

    function shapeAudit(a) {
        return a ? { id: a.id, action: a.action, cluster_id: a.cluster_id, other_id: a.other_id, item_ids: parse(a.item_ids, []), reason: a.reason, actor: a.actor, reverses: a.reverses, reversed_by: a.reversed_by, at: new Date(a.created_at).toISOString() } : null;
    }

    const api = {
        signature, compare, coreMin, itemTime, labelOf, assign, resolve, recompute,

        get: async (id) => await q.get.get(String(id || '')) || null,
        members: async (id) => await q.members.all(id),
        audit: async (id) => (await q.auditFor.all(id, id)).map(shapeAudit),
        auditEntry: async (id) => shapeAudit(await q.audit.get(String(id || ''))),

        /**
         * The public wire: open clusters, newest activity first, each with its active items (no duplicates, nothing
         * removed upstream) as the sources state them: headline, outlet, date and link. Clusters left with no active
         * item are skipped. Only the fields the licensing rules let News store are read.
         */
        async wire({ limit = 30 } = {}) {
            const out = [];
            for (const c of await api.recent({ limit: limit * 2 })) {
                const items = (await q.members.all(c.id)).filter((i) => i.status === 'active' && !i.removed_at && i.canonical_url)
                    .map((i) => ({ id: i.id, headline: i.headline, url: i.canonical_url, outlet: i.outlet, published_at: i.published_at }));
                if (!items.length) continue;
                items.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
                out.push({ id: c.id, label: c.label, updated: c.window_end, items });
                if (out.length >= limit) break;
            }
            return out;
        },

        /** Open clusters, newest activity first (the editor dashboard). */
        async recent({ limit = 50 } = {}) {
            return await db.prepare("SELECT * FROM news_story_clusters WHERE status = 'open' ORDER BY window_end DESC, id DESC LIMIT ?").all(limit);
        },

        /** Merge cluster `otherId` into `intoId`. */
        async merge(viewer, intoId, otherId, { reason = null } = {}) {
            return await store.tx(async () => {
                const into = await mustOpen(intoId);
                const other = await mustOpen(otherId);
                if (into.id === other.id) throw new ApiError(422, 'cluster.same', 'A cluster cannot be merged into itself');
                const moved = (await q.members.all(other.id)).map((i) => i.id);
                const now = store.now();
                for (const id of moved) await q.setItem.run(into.id, JSON.stringify({ rule: 'merged', from: other.id }), now, id);
                await db.prepare("UPDATE news_story_clusters SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(into.id, now, other.id);
                const audit = await recordAudit({ action: 'merge', cluster_id: into.id, other_id: other.id, item_ids: moved, reason: reason ? String(reason).slice(0, 500) : null, actor: actorId(viewer) });
                const c = await recompute(into.id);
                await emit(c, 'merged', { absorbed: other.id, audit_id: audit.id, moved: moved.length });
                return { cluster: c, audit: shapeAudit(audit) };
            });
        },

        /** Move some items of a cluster into a new cluster. At least one item must stay. */
        async split(viewer, clusterId, itemIds, { reason = null } = {}) {
            return await store.tx(async () => {
                const from = await mustOpen(clusterId);
                const members = new Set((await q.members.all(from.id)).map((i) => i.id));
                const wanted = [...new Set((itemIds || []).map(String))];
                if (!wanted.length) throw new ApiError(422, 'cluster.split_empty', 'Choose the items to split off');
                for (const id of wanted) if (!members.has(id)) throw new ApiError(422, 'cluster.split_foreign', `${id} is not in cluster ${from.id}`);
                if (wanted.length >= members.size) throw new ApiError(422, 'cluster.split_all', 'At least one item must stay in the cluster');
                const now = store.now();
                const id = newClusterId(now);
                await q.insert.run({ id, label: 'new', split_from: from.id, terms: '{}', entities: '{}', window_start: null, window_end: null, created_by: actorId(viewer), now });
                for (const it of wanted) await q.setItem.run(id, JSON.stringify({ rule: 'split', from: from.id }), now, it);
                const audit = await recordAudit({ action: 'split', cluster_id: from.id, other_id: id, item_ids: wanted, reason: reason ? String(reason).slice(0, 500) : null, actor: actorId(viewer) });
                const a = await recompute(from.id);
                const b = await recompute(id);
                await emit(a, 'split', { new_cluster: id, audit_id: audit.id, moved: wanted.length });
                await emit(b, 'created', { split_from: from.id, audit_id: audit.id });
                return { cluster: a, created: b, audit: shapeAudit(audit) };
            });
        },

        /**
         * Regroup one open cluster's reports with today's rule (coreMin), in the order they were published: each
         * report joins the group whose core it shares the most with inside the window, a duplicate follows its
         * original. The group holding the first report stays; every other group is split off as an editor's split
         * would be (audited, reversible one by one). Removed reports stay where they are. dryRun answers the grouping
         * and changes nothing. → { cluster, groups, splits, grouping: [[item id, …], …] }
         */
        async resplit(viewer, clusterId, { reason = null, dryRun = false } = {}) {
            const from = await mustOpen(clusterId);
            const w = config.clustering.windowMs;
            const members = (await q.members.all(from.id)).filter((i) => i.status !== 'removed')
                .sort((a, b) => (itemTime(a) - itemTime(b)) || (a.first_seen_at - b.first_seen_at) || (a.seq - b.seq));
            const groups = [];
            const add = (g, it) => {
                const sig = signature(it);
                for (const t of sig.terms) g.terms[t] = (g.terms[t] || 0) + 1;
                for (const e of sig.entities) g.entities[e] = (g.entities[e] || 0) + 1;
                const at = itemTime(it);
                g.start = Math.min(g.start, at); g.end = Math.max(g.end, at);
                g.ids.push(it.id);
            };
            for (const it of members) {
                let into = it.status === 'duplicate' && it.duplicate_of ? groups.find((g) => g.ids.includes(it.duplicate_of)) : null;
                if (!into) {
                    const sig = signature(it);
                    const at = itemTime(it);
                    let best = null;
                    for (const g of groups) {
                        if (g.end < at - w || g.start > at + w) continue;
                        const m = compare(sig, g, g.ids.length);
                        if (m.joins && (!best || m.score > best.m.score)) best = { g, m };
                    }
                    into = best ? best.g : null;
                }
                if (!into) { into = { terms: {}, entities: {}, start: Infinity, end: -Infinity, ids: [] }; groups.push(into); }
                add(into, it);
            }
            const grouping = groups.map((g) => g.ids);
            if (dryRun) return { cluster: from, groups: groups.length, splits: [], grouping };
            const splits = [];
            const why = reason ? String(reason).slice(0, 500) : 'regrouped on the cluster\'s core terms';
            for (const g of groups.slice(1)) splits.push((await api.split(viewer, from.id, g.ids, { reason: why })).audit);
            return { cluster: await q.get.get(from.id), groups: groups.length, splits, grouping };
        },

        /**
         * Undo a merge or a split: the items that moved (and are still where they were moved to) go
         * back; the absorbed cluster reopens / the split-off cluster is dissolved. Audited as well.
         */
        async reverse(viewer, auditId, { reason = null } = {}) {
            return await store.tx(async () => {
                const a = await q.audit.get(String(auditId || ''));
                if (!a) throw new ApiError(404, 'cluster.audit_not_found', 'No such merge or split');
                if (a.reversed_by) throw new ApiError(409, 'cluster.already_reversed', `Already reversed by ${a.reversed_by}`);
                if (a.action !== 'merge' && a.action !== 'split') throw new ApiError(422, 'cluster.not_reversible', 'Only merges and splits can be reversed');
                const now = store.now();
                const items = parse(a.item_ids, []);
                let moved = [];
                let result;
                if (a.action === 'merge') {
                    const other = await q.get.get(a.other_id);
                    if (!other || other.status !== 'merged' || other.merged_into !== a.cluster_id) throw new ApiError(409, 'cluster.changed', 'The absorbed cluster has changed since the merge');
                    const now1 = new Map((await db.prepare('SELECT id, cluster_id FROM news_source_items WHERE id = ANY(?)').all(items)).map((r) => [r.id, r.cluster_id]));
                    moved = items.filter((id) => now1.get(id) === a.cluster_id);
                    for (const id of moved) await q.setItem.run(other.id, JSON.stringify({ rule: 'merge_reversed', audit: a.id }), now, id);
                    await db.prepare("UPDATE news_story_clusters SET status = 'open', merged_into = NULL, updated_at = ? WHERE id = ?").run(now, other.id);
                    const rev = await recordAudit({ action: 'reverse_merge', cluster_id: a.cluster_id, other_id: other.id, item_ids: moved, reason: reason ? String(reason).slice(0, 500) : null, actor: actorId(viewer), reverses: a.id });
                    await db.prepare('UPDATE news_cluster_audit SET reversed_by = ? WHERE id = ?').run(rev.id, a.id);
                    const c1 = await recompute(a.cluster_id);
                    const c2 = await recompute(other.id);
                    await emit(c1, 'merge_reversed', { audit_id: rev.id, restored: other.id });
                    await emit(c2, 'reopened', { audit_id: rev.id });
                    result = { audit: shapeAudit(await q.audit.get(rev.id)), clusters: [c1, c2] };
                } else {
                    const split = await q.get.get(a.other_id);
                    const from = await q.get.get(a.cluster_id);
                    if (!split || split.status !== 'open' || !from || from.status !== 'open') throw new ApiError(409, 'cluster.changed', 'One of the clusters is no longer open');
                    const now2 = new Map((await db.prepare('SELECT id, cluster_id FROM news_source_items WHERE id = ANY(?)').all(items)).map((r) => [r.id, r.cluster_id]));
                    moved = items.filter((id) => now2.get(id) === split.id);
                    for (const id of moved) await q.setItem.run(from.id, JSON.stringify({ rule: 'split_reversed', audit: a.id }), now, id);
                    const left = (await q.members.all(split.id)).length;
                    if (!left) await db.prepare("UPDATE news_story_clusters SET status = 'dissolved', updated_at = ? WHERE id = ?").run(now, split.id);
                    const rev = await recordAudit({ action: 'reverse_split', cluster_id: from.id, other_id: split.id, item_ids: moved, reason: reason ? String(reason).slice(0, 500) : null, actor: actorId(viewer), reverses: a.id });
                    await db.prepare('UPDATE news_cluster_audit SET reversed_by = ? WHERE id = ?').run(rev.id, a.id);
                    const c1 = await recompute(from.id);
                    const c2 = left ? await recompute(split.id) : await q.get.get(split.id);
                    await emit(c1, 'split_reversed', { audit_id: rev.id, dissolved: left ? null : split.id });
                    result = { audit: shapeAudit(await q.audit.get(rev.id)), clusters: [c1, c2] };
                }
                return result;
            });
        },
    };
    return api;
}

module.exports = { createClusters, signature, compare, coreMin, itemTime, labelOf };
