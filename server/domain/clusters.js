'use strict';

/**
 * Clusters: deterministic, explainable grouping of source items that report the same story.
 *
 *   assign(item)   an active item joins the open cluster it shares the most with inside the time
 *                  window (NEWS_CLUSTER_WINDOW_HOURS, default 72 h):
 *                    shared named entities count 2, shared terms count 1;
 *                    it joins when (≥ 1 shared entity AND ≥ 2 shared terms) OR ≥ 3 shared terms;
 *                    ties go to the oldest cluster. Otherwise it starts a new cluster.
 *                  The decision is stored on the item (cluster_reason) with the shared entities,
 *                  shared terms and score, so every membership can be explained and recomputed.
 *                  A duplicate joins its original's cluster (rule "duplicate_of").
 *   merge(a, b)    an editor merges b into a; split(a, items) moves items into a new cluster.
 *                  Both are audited (news_cluster_audit, with exactly which items moved) and
 *                  reversible (reverse(auditId)); nothing is deleted.
 *
 * Every change emits news.cluster.updated (internal) in the same transaction.
 */
const { ids } = require('openvibe-contracts');
const text = require('./text');
const { ApiError } = require('../http/errors');

const newClusterId = (now) => `clu_${ids.ulid(now)}`;
const newAuditId = (now) => `cla_${ids.ulid(now)}`;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Terms and entities of one item (headline + the licensed summary we store). */
function signature(item) {
    const t = `${item.headline || ''}. ${item.summary || ''}`;
    return { terms: text.terms(t), entities: text.entities(item.headline || '').concat(text.entities(item.summary || '')).filter((v, i, a) => a.indexOf(v) === i).sort() };
}

/** The time an item is placed at: when the source says it was published, else when News first saw it. */
function itemTime(item) {
    const p = item.published_at ? Date.parse(item.published_at) : NaN;
    return Number.isFinite(p) ? p : item.first_seen_at;
}

/** Match an item's signature against a cluster's. → { sharedEntities, sharedTerms, score, joins } */
function compare(sig, cluster) {
    const ce = parse(cluster.entities, {});
    const ct = parse(cluster.terms, {});
    const sharedEntities = sig.entities.filter((e) => ce[e]);
    const sharedTerms = sig.terms.filter((t) => ct[t]);
    const score = 2 * sharedEntities.length + sharedTerms.length;
    const joins = (sharedEntities.length >= 1 && sharedTerms.length >= 2) || sharedTerms.length >= 3;
    return { sharedEntities, sharedTerms, score, joins };
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
        open: db.prepare(`SELECT * FROM news_story_clusters WHERE status = 'open' AND window_end >= ? AND window_start <= ? ORDER BY created_at, rowid`),
        insert: db.prepare(`INSERT INTO news_story_clusters (id, label, status, split_from, terms, entities, window_start, window_end, created_by, created_at, updated_at)
                            VALUES (@id, @label, 'open', @split_from, @terms, @entities, @window_start, @window_end, @created_by, @now, @now)`),
        members: db.prepare("SELECT * FROM news_source_items WHERE cluster_id = ? ORDER BY first_seen_at, rowid"),
        setItem: db.prepare('UPDATE news_source_items SET cluster_id = ?, cluster_reason = ?, updated_at = ? WHERE id = ?'),
        audit: db.prepare('SELECT * FROM news_cluster_audit WHERE id = ?'),
        auditFor: db.prepare('SELECT * FROM news_cluster_audit WHERE cluster_id = ? OR other_id = ? ORDER BY created_at, rowid'),
        insertAudit: db.prepare(`INSERT INTO news_cluster_audit (id, action, cluster_id, other_id, item_ids, reason, actor, reverses, created_at)
                                 VALUES (@id, @action, @cluster_id, @other_id, @item_ids, @reason, @actor, @reverses, @now)`),
    };

    function emit(cluster, action, extra = {}) {
        outbox.emit({
            event_type: 'news.cluster.updated', actor: { type: 'service', id: 'news' }, visibility: 'internal', priority: 'low',
            subject: { type: 'cluster', id: cluster.id },
            payload: { cluster_id: cluster.id, action, status: cluster.status, label: cluster.label, item_count: q.members.all(cluster.id).length, ...extra },
        });
    }

    /** Rebuild a cluster's terms, entities, window and label from its members (removed items do not count). */
    function recompute(clusterId) {
        const terms = {};
        const entities = {};
        let start = null;
        let end = null;
        for (const it of q.members.all(clusterId)) {
            if (it.status === 'removed') continue;
            const sig = signature(it);
            for (const t of sig.terms) terms[t] = (terms[t] || 0) + 1;
            for (const e of sig.entities) entities[e] = (entities[e] || 0) + 1;
            const at = itemTime(it);
            start = start == null ? at : Math.min(start, at);
            end = end == null ? at : Math.max(end, at);
        }
        db.prepare('UPDATE news_story_clusters SET terms = ?, entities = ?, window_start = COALESCE(?, window_start), window_end = COALESCE(?, window_end), label = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(terms), JSON.stringify(entities), start, end, labelOf(entities, terms), store.now(), clusterId);
        return q.get.get(clusterId);
    }

    /**
     * Place one item (inside the ingest transaction). Duplicates follow their original. Returns
     * { cluster, created, reason }.
     */
    function assign(item) {
        if (item.status === 'duplicate' && item.duplicate_of) {
            const original = db.prepare('SELECT * FROM news_source_items WHERE id = ?').get(item.duplicate_of);
            if (original && original.cluster_id) {
                const cluster = resolve(original.cluster_id);
                const reason = { rule: 'duplicate_of', item: original.id };
                q.setItem.run(cluster.id, JSON.stringify(reason), store.now(), item.id);
                emit(cluster, 'item_added', { item_id: item.id, rule: 'duplicate_of' });
                return { cluster, created: false, reason };
            }
        }
        const sig = signature(item);
        const at = itemTime(item);
        const w = config.clustering.windowMs;
        let best = null;
        for (const c of q.open.all(at - w, at + w)) {
            const m = compare(sig, c);
            if (!m.joins) continue;
            if (!best || m.score > best.m.score) best = { c, m };   // ORDER BY created_at, rowid: the oldest wins a tie
        }
        if (best) {
            const reason = { rule: 'shared_terms', cluster: best.c.id, shared_entities: best.m.sharedEntities, shared_terms: best.m.sharedTerms, score: best.m.score, window_hours: w / 3600000 };
            q.setItem.run(best.c.id, JSON.stringify(reason), store.now(), item.id);
            const cluster = recompute(best.c.id);
            emit(cluster, 'item_added', { item_id: item.id, rule: 'shared_terms', score: best.m.score });
            return { cluster, created: false, reason };
        }
        const now = store.now();
        const id = newClusterId(now);
        q.insert.run({ id, label: 'new', split_from: null, terms: '{}', entities: '{}', window_start: at, window_end: at, created_by: 'svc:news', now });
        const reason = { rule: 'new_cluster', cluster: id, terms: sig.terms.slice(0, 20), entities: sig.entities.slice(0, 10) };
        q.setItem.run(id, JSON.stringify(reason), now, item.id);
        const cluster = recompute(id);
        emit(cluster, 'created', { item_id: item.id });
        return { cluster, created: true, reason };
    }

    /** Follow merges to the cluster that holds the items now. */
    function resolve(id) {
        let c = q.get.get(id);
        for (let i = 0; c && c.status === 'merged' && c.merged_into && i < 50; i++) c = q.get.get(c.merged_into);
        return c;
    }

    function mustOpen(id) {
        const c = q.get.get(String(id || ''));
        if (!c) throw new ApiError(404, 'cluster.not_found', 'No such cluster');
        if (c.status !== 'open') throw new ApiError(409, 'cluster.not_open', `Cluster ${c.id} is ${c.status}`);
        return c;
    }

    function actorId(viewer) { return viewer && viewer.subject ? viewer.subject : (viewer && viewer.service) || 'svc:news'; }

    function recordAudit(row) {
        const now = store.now();
        const id = newAuditId(now);
        q.insertAudit.run({ id, reason: null, reverses: null, ...row, item_ids: JSON.stringify(row.item_ids), now });
        return q.audit.get(id);
    }

    function shapeAudit(a) {
        return a ? { id: a.id, action: a.action, cluster_id: a.cluster_id, other_id: a.other_id, item_ids: parse(a.item_ids, []), reason: a.reason, actor: a.actor, reverses: a.reverses, reversed_by: a.reversed_by, at: new Date(a.created_at).toISOString() } : null;
    }

    const api = {
        signature, compare, itemTime, labelOf, assign, resolve, recompute,

        get: (id) => q.get.get(String(id || '')) || null,
        members: (id) => q.members.all(id),
        audit: (id) => q.auditFor.all(id, id).map(shapeAudit),
        auditEntry: (id) => shapeAudit(q.audit.get(String(id || ''))),

        /** Open clusters, newest activity first (the editor dashboard). */
        recent({ limit = 50 } = {}) {
            return db.prepare("SELECT * FROM news_story_clusters WHERE status = 'open' ORDER BY window_end DESC, id DESC LIMIT ?").all(limit);
        },

        /** Merge cluster `otherId` into `intoId`. */
        merge(viewer, intoId, otherId, { reason = null } = {}) {
            return store.tx(() => {
                const into = mustOpen(intoId);
                const other = mustOpen(otherId);
                if (into.id === other.id) throw new ApiError(422, 'cluster.same', 'A cluster cannot be merged into itself');
                const moved = q.members.all(other.id).map((i) => i.id);
                const now = store.now();
                for (const id of moved) q.setItem.run(into.id, JSON.stringify({ rule: 'merged', from: other.id }), now, id);
                db.prepare("UPDATE news_story_clusters SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(into.id, now, other.id);
                const audit = recordAudit({ action: 'merge', cluster_id: into.id, other_id: other.id, item_ids: moved, reason: reason ? String(reason).slice(0, 500) : null, actor: actorId(viewer) });
                const c = recompute(into.id);
                emit(c, 'merged', { absorbed: other.id, audit_id: audit.id, moved: moved.length });
                return { cluster: c, audit: shapeAudit(audit) };
            });
        },

        /** Move some items of a cluster into a new cluster. At least one item must stay. */
        split(viewer, clusterId, itemIds, { reason = null } = {}) {
            return store.tx(() => {
                const from = mustOpen(clusterId);
                const members = new Set(q.members.all(from.id).map((i) => i.id));
                const wanted = [...new Set((itemIds || []).map(String))];
                if (!wanted.length) throw new ApiError(422, 'cluster.split_empty', 'Choose the items to split off');
                for (const id of wanted) if (!members.has(id)) throw new ApiError(422, 'cluster.split_foreign', `${id} is not in cluster ${from.id}`);
                if (wanted.length >= members.size) throw new ApiError(422, 'cluster.split_all', 'At least one item must stay in the cluster');
                const now = store.now();
                const id = newClusterId(now);
                q.insert.run({ id, label: 'new', split_from: from.id, terms: '{}', entities: '{}', window_start: null, window_end: null, created_by: actorId(viewer), now });
                for (const it of wanted) q.setItem.run(id, JSON.stringify({ rule: 'split', from: from.id }), now, it);
                const audit = recordAudit({ action: 'split', cluster_id: from.id, other_id: id, item_ids: wanted, reason: reason ? String(reason).slice(0, 500) : null, actor: actorId(viewer) });
                const a = recompute(from.id);
                const b = recompute(id);
                emit(a, 'split', { new_cluster: id, audit_id: audit.id, moved: wanted.length });
                emit(b, 'created', { split_from: from.id, audit_id: audit.id });
                return { cluster: a, created: b, audit: shapeAudit(audit) };
            });
        },

        /**
         * Undo a merge or a split: the items that moved (and are still where they were moved to) go
         * back; the absorbed cluster reopens / the split-off cluster is dissolved. Audited as well.
         */
        reverse(viewer, auditId, { reason = null } = {}) {
            return store.tx(() => {
                const a = q.audit.get(String(auditId || ''));
                if (!a) throw new ApiError(404, 'cluster.audit_not_found', 'No such merge or split');
                if (a.reversed_by) throw new ApiError(409, 'cluster.already_reversed', `Already reversed by ${a.reversed_by}`);
                if (a.action !== 'merge' && a.action !== 'split') throw new ApiError(422, 'cluster.not_reversible', 'Only merges and splits can be reversed');
                const now = store.now();
                const items = parse(a.item_ids, []);
                let moved = [];
                let result;
                if (a.action === 'merge') {
                    const other = q.get.get(a.other_id);
                    if (!other || other.status !== 'merged' || other.merged_into !== a.cluster_id) throw new ApiError(409, 'cluster.changed', 'The absorbed cluster has changed since the merge');
                    moved = items.filter((id) => (db.prepare('SELECT cluster_id FROM news_source_items WHERE id = ?').get(id) || {}).cluster_id === a.cluster_id);
                    for (const id of moved) q.setItem.run(other.id, JSON.stringify({ rule: 'merge_reversed', audit: a.id }), now, id);
                    db.prepare("UPDATE news_story_clusters SET status = 'open', merged_into = NULL, updated_at = ? WHERE id = ?").run(now, other.id);
                    const rev = recordAudit({ action: 'reverse_merge', cluster_id: a.cluster_id, other_id: other.id, item_ids: moved, reason: reason ? String(reason).slice(0, 500) : null, actor: actorId(viewer), reverses: a.id });
                    db.prepare('UPDATE news_cluster_audit SET reversed_by = ? WHERE id = ?').run(rev.id, a.id);
                    const c1 = recompute(a.cluster_id);
                    const c2 = recompute(other.id);
                    emit(c1, 'merge_reversed', { audit_id: rev.id, restored: other.id });
                    emit(c2, 'reopened', { audit_id: rev.id });
                    result = { audit: shapeAudit(q.audit.get(rev.id)), clusters: [c1, c2] };
                } else {
                    const split = q.get.get(a.other_id);
                    const from = q.get.get(a.cluster_id);
                    if (!split || split.status !== 'open' || !from || from.status !== 'open') throw new ApiError(409, 'cluster.changed', 'One of the clusters is no longer open');
                    moved = items.filter((id) => (db.prepare('SELECT cluster_id FROM news_source_items WHERE id = ?').get(id) || {}).cluster_id === split.id);
                    for (const id of moved) q.setItem.run(from.id, JSON.stringify({ rule: 'split_reversed', audit: a.id }), now, id);
                    const left = q.members.all(split.id).length;
                    if (!left) db.prepare("UPDATE news_story_clusters SET status = 'dissolved', updated_at = ? WHERE id = ?").run(now, split.id);
                    const rev = recordAudit({ action: 'reverse_split', cluster_id: from.id, other_id: split.id, item_ids: moved, reason: reason ? String(reason).slice(0, 500) : null, actor: actorId(viewer), reverses: a.id });
                    db.prepare('UPDATE news_cluster_audit SET reversed_by = ? WHERE id = ?').run(rev.id, a.id);
                    const c1 = recompute(from.id);
                    const c2 = left ? recompute(split.id) : q.get.get(split.id);
                    emit(c1, 'split_reversed', { audit_id: rev.id, dissolved: left ? null : split.id });
                    result = { audit: shapeAudit(q.audit.get(rev.id)), clusters: [c1, c2] };
                }
                return result;
            });
        },
    };
    return api;
}

module.exports = { createClusters, signature, compare, itemTime, labelOf };
