'use strict';
/**
 * Clusters are deterministic and explainable, and every merge and split is audited and reversible:
 * reversing puts exactly the moved items back, reopens (or dissolves) the other cluster, and is
 * audited too. The same input in the same order gives the same clusters.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const reports = launchReports(t.sources);
    const other = t.sources.addItem({ source_key: 'paper-b', title: 'Clipper mission team answers questions about Jupiter cruise', url: 'https://paper-b.example/qa', published_at: '2026-09-22T10:30:00Z' });
    const unrelated = t.sources.addItem({ source_key: 'site-c', title: 'Local bakery wins regional sourdough prize', url: 'https://site-c.example/bakery', published_at: '2026-09-22T10:40:00Z' });
    await t.pull();
    const item = (itm) => t.db().prepare('SELECT * FROM news_source_items WHERE sources_item_id = ?').get(itm);
    const main = item(reports.a.id).cluster_id;
    const lone = item(unrelated.id).cluster_id;

    await check('clustering is deterministic: rebuilding from the same items in the same order gives the same grouping', async () => {
        const { createClusters } = require('../server/domain/clusters');
        const cfg = t.ctx.config;
        const { openStore } = require('../server/db');
        const store = openStore(':memory:', { now: t.ctx.store.now });
        const db = store.db;
        const events = [];
        const c2 = createClusters({ store, config: cfg, outbox: { emit: (e) => events.push(e) } });
        const rows = t.db().prepare("SELECT * FROM news_source_items WHERE status <> 'duplicate' ORDER BY first_seen_at, rowid").all();
        const groups = new Map();
        for (const r of rows) {
            db.prepare('INSERT INTO news_source_items (id, sources_item_id, sources_revision, source_key, headline, outlet, title_key, status, published_at, summary, first_seen_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
                .run(r.id, r.sources_item_id, r.sources_revision, r.source_key, r.headline, r.outlet, r.title_key, r.status, r.published_at, r.summary, r.first_seen_at, r.updated_at);
            const out = c2.assign(db.prepare('SELECT * FROM news_source_items WHERE id = ?').get(r.id));
            groups.set(r.id, out.cluster.id);
        }
        const original = new Map(rows.map((r) => [r.id, r.cluster_id]));
        const same = (m) => { const byC = new Map(); for (const [i, c] of m) { if (!byC.has(c)) byC.set(c, []); byC.get(c).push(i); } return [...byC.values()].map((v) => v.sort().join(',')).sort(); };
        assert.deepStrictEqual(same(groups), same(original));
    });

    await check('the cluster page explains every membership (shared entities and terms, score, window)', async () => {
        const r = await t.api(`/clusters/${main}`);
        assert.strictEqual(r.status, 200, r.text);
        const c = r.json().cluster;
        assert.ok(c.item_count >= 3);
        assert.ok(c.key_entities.some((e) => e.entity === 'europa clipper'));
        for (const it of c.items) assert.ok(it.cluster_reason && it.cluster_reason.rule, JSON.stringify(it));
        const page = await t.get(`/clusters/${main}`, { as: t.editor });
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /shares entities/);
        assert.match(page.headers.get('x-robots-tag'), /noindex/);
        assert.strictEqual(page.headers.get('cache-control'), 'private, no-store');
        const anon = await t.get(`/clusters/${main}`);
        assert.strictEqual(anon.status, 303, 'clusters are for editors');
        const reader = await t.get(`/clusters/${main}`, { as: t.network.addUser('reader') });
        assert.strictEqual(reader.status, 403);
    });

    let mergeAudit;
    await check('merge is audited: the absorbed cluster’s items move, it is marked merged', async () => {
        const before = t.ctx.clusters.members(lone).map((i) => i.id);
        const r = await t.api(`/clusters/${main}/merge`, { json: { other: lone, reason: 'testing a merge' } });
        assert.strictEqual(r.status, 200, r.text);
        mergeAudit = r.json().audit;
        assert.strictEqual(mergeAudit.action, 'merge');
        assert.deepStrictEqual(mergeAudit.item_ids.sort(), before.sort());
        assert.strictEqual(item(unrelated.id).cluster_id, main);
        assert.strictEqual(t.ctx.clusters.get(lone).status, 'merged');
        assert.strictEqual(t.ctx.clusters.get(lone).merged_into, main);
        const ev = t.events('news.cluster.updated').filter((e) => e.payload.action === 'merged');
        assert.strictEqual(ev.length, 1);
    });

    await check('reversing the merge restores exactly the moved items and reopens the cluster', async () => {
        const r = await t.api(`/clusters/audit/${mergeAudit.id}/reverse`, { json: { reason: 'wrong merge' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().audit.action, 'reverse_merge');
        assert.strictEqual(item(unrelated.id).cluster_id, lone);
        assert.strictEqual(item(reports.a.id).cluster_id, main);
        assert.strictEqual(t.ctx.clusters.get(lone).status, 'open');
        const again = await t.api(`/clusters/audit/${mergeAudit.id}/reverse`, { json: {} });
        assert.strictEqual(again.status, 409);
        assert.strictEqual(again.json().code, 'cluster.already_reversed');
    });

    let splitAudit;
    let splitId;
    await check('split is audited: chosen items move to a new cluster; at least one must stay', async () => {
        const all = t.ctx.clusters.members(main).map((i) => i.id);
        let r = await t.api(`/clusters/${main}/split`, { json: { items: all } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'cluster.split_all');
        const moving = [item(other.id).id];
        r = await t.api(`/clusters/${main}/split`, { json: { items: moving, reason: 'a Q&A is a different story' } });
        assert.strictEqual(r.status, 201, r.text);
        splitAudit = r.json().audit;
        splitId = r.json().created.id;
        assert.strictEqual(item(other.id).cluster_id, splitId);
        assert.strictEqual(t.ctx.clusters.get(splitId).split_from, main);
    });

    await check('reversing the split puts the items back and dissolves the empty cluster (through the no-JS form)', async () => {
        const csrf = t.csrf(t.editor);
        const r = await t.get(`/clusters/audit/${splitAudit.id}/reverse`, { as: t.editor, form: { _csrf: csrf, reason: 'undo' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual(item(other.id).cluster_id, main);
        assert.strictEqual(t.ctx.clusters.get(splitId).status, 'dissolved');
        const audit = t.ctx.clusters.audit(main).map((a) => a.action);
        assert.deepStrictEqual(audit, ['merge', 'reverse_merge', 'split', 'reverse_split']);
    });

    await t.close();
    done();
})();
