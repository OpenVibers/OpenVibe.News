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
    const other = t.sources.addItem({ source_key: 'paper-b', title: 'Clipper mission team answers questions about Jupiter cruise', url: 'https://paper-b.example/qa', summary: 'After the Europa Clipper launch, NASA mission scientists explained the long cruise to Jupiter.', published_at: '2026-09-22T10:30:00Z' });
    const unrelated = t.sources.addItem({ source_key: 'site-c', title: 'Local bakery wins regional sourdough prize', url: 'https://site-c.example/bakery', published_at: '2026-09-22T10:40:00Z' });
    await t.pull();
    const item = async (itm) => await t.db().prepare('SELECT * FROM news_source_items WHERE sources_item_id = ?').get(itm);
    const main = (await item(reports.a.id)).cluster_id;
    const lone = (await item(unrelated.id)).cluster_id;

    await check('clustering is deterministic: rebuilding from the same items in the same order gives the same grouping', async () => {
        const { createClusters } = require('../server/domain/clusters');
        const cfg = t.ctx.config;
        const { createStore } = require('../server/db');
        const fresh = await require('./helpers/db').testDb();
        const store = createStore(fresh.db, { now: t.ctx.store.now });
        const db = store.db;
        const events = [];
        const c2 = createClusters({ store, config: cfg, outbox: { emit: (e) => events.push(e) } });
        const rows = await t.db().prepare("SELECT * FROM news_source_items WHERE status <> 'duplicate' ORDER BY first_seen_at, seq").all();
        const groups = new Map();
        for (const r of rows) {
            await db.prepare('INSERT INTO news_source_items (id, sources_item_id, sources_revision, source_key, headline, outlet, title_key, status, published_at, summary, first_seen_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
                .run(r.id, r.sources_item_id, r.sources_revision, r.source_key, r.headline, r.outlet, r.title_key, r.status, r.published_at, r.summary, r.first_seen_at, r.updated_at);
            const out = await c2.assign(await db.prepare('SELECT * FROM news_source_items WHERE id = ?').get(r.id));
            groups.set(r.id, out.cluster.id);
        }
        const original = new Map(rows.map((r) => [r.id, r.cluster_id]));
        const same = (m) => { const byC = new Map(); for (const [i, c] of m) { if (!byC.has(c)) byC.set(c, []); byC.get(c).push(i); } return [...byC.values()].map((v) => v.sort().join(',')).sort(); };
        await fresh.close();
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
        const before = (await t.ctx.clusters.members(lone)).map((i) => i.id);
        const r = await t.api(`/clusters/${main}/merge`, { json: { other: lone, reason: 'testing a merge' } });
        assert.strictEqual(r.status, 200, r.text);
        mergeAudit = r.json().audit;
        assert.strictEqual(mergeAudit.action, 'merge');
        assert.deepStrictEqual(mergeAudit.item_ids.sort(), before.sort());
        assert.strictEqual((await item(unrelated.id)).cluster_id, main);
        assert.strictEqual((await t.ctx.clusters.get(lone)).status, 'merged');
        assert.strictEqual((await t.ctx.clusters.get(lone)).merged_into, main);
        const ev = (await t.events('news.cluster.updated')).filter((e) => e.payload.action === 'merged');
        assert.strictEqual(ev.length, 1);
    });

    await check('reversing the merge restores exactly the moved items and reopens the cluster', async () => {
        const r = await t.api(`/clusters/audit/${mergeAudit.id}/reverse`, { json: { reason: 'wrong merge' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().audit.action, 'reverse_merge');
        assert.strictEqual((await item(unrelated.id)).cluster_id, lone);
        assert.strictEqual((await item(reports.a.id)).cluster_id, main);
        assert.strictEqual((await t.ctx.clusters.get(lone)).status, 'open');
        const again = await t.api(`/clusters/audit/${mergeAudit.id}/reverse`, { json: {} });
        assert.strictEqual(again.status, 409);
        assert.strictEqual(again.json().code, 'cluster.already_reversed');
    });

    let splitAudit;
    let splitId;
    await check('split is audited: chosen items move to a new cluster; at least one must stay', async () => {
        const all = (await t.ctx.clusters.members(main)).map((i) => i.id);
        let r = await t.api(`/clusters/${main}/split`, { json: { items: all } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'cluster.split_all');
        const moving = [(await item(other.id)).id];
        r = await t.api(`/clusters/${main}/split`, { json: { items: moving, reason: 'a Q&A is a different story' } });
        assert.strictEqual(r.status, 201, r.text);
        splitAudit = r.json().audit;
        splitId = r.json().created.id;
        assert.strictEqual((await item(other.id)).cluster_id, splitId);
        assert.strictEqual((await t.ctx.clusters.get(splitId)).split_from, main);
    });

    await check('reversing the split puts the items back and dissolves the empty cluster (through the no-JS form)', async () => {
        const csrf = t.csrf(t.editor);
        const r = await t.get(`/clusters/audit/${splitAudit.id}/reverse`, { as: t.editor, form: { _csrf: csrf, reason: 'undo' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual((await item(other.id)).cluster_id, main);
        assert.strictEqual((await t.ctx.clusters.get(splitId)).status, 'dissolved');
        const audit = (await t.ctx.clusters.audit(main)).map((a) => a.action);
        assert.deepStrictEqual(audit, ['merge', 'reverse_merge', 'split', 'reverse_split']);
    });

    await check('a cluster is matched on its core, not the union of its reports: it cannot snowball', async () => {
        const { compare, coreMin, signature } = require('../server/domain/clusters');
        assert.deepStrictEqual([1, 2, 3, 5, 6, 196].map(coreMin), [1, 1, 2, 2, 3, 66]);
        // Nine statements from one outlet: "statement", "ambassador" and "security" are in all nine; a railway report
        // is in the union once. A new railway report shares three union terms but none of the core.
        const terms = { statement: 9, ambassador: 9, security: 9, railway: 1, british: 1, scheme: 1, great: 1 };
        const cluster = { terms: JSON.stringify(terms), entities: JSON.stringify({ un: 9, 'great british railways': 1 }) };
        const railway = signature({ headline: 'Great British Railways confirms its apprenticeship scheme', summary: 'The railway scheme opens to young people.' });
        assert.strictEqual(compare(railway, cluster, 1).joins, true, 'the union would take it');
        const m = compare(railway, cluster, 9);
        assert.strictEqual(m.joins, false, JSON.stringify(m));
        assert.strictEqual(m.coreMin, 4);
        const statement = signature({ headline: 'UN ambassador statement on security in Haiti', summary: 'The ambassador gave a statement to the security council.' });
        assert.strictEqual(compare(statement, cluster, 9).joins, true, 'a report on the story itself still joins');
    });

    await check('dates never join reports, and neither do an outlet\'s own boilerplate words', async () => {
        const { signature, commonWords, compare } = require('../server/domain/clusters');
        const sig = signature({ headline: 'Statement on Tuesday 13 October 2026 at 10:00 EDT', summary: 'Published in October.' });
        assert.ok(!sig.terms.some((w) => /^(tuesday|13|october|2026|edt)$/.test(w)), sig.terms.join(','));
        const report = (source, headline) => ({ source_key: source, sig: signature({ headline }) });
        const pool = ['Haiti sanctions', 'Libya talks', 'Yemen escalation', 'Syria sovereignty', 'Colombia peace'].map((x) => report('govuk', `UK statement at the UN Security Council on ${x}`));
        const common = commonWords('govuk', pool);
        assert.ok(common.has('statement') && common.has('council'), [...common].join(','));
        assert.ok(!common.has('haiti'), 'a story\'s own words stay');
        assert.strictEqual(commonWords('govuk', pool.slice(0, 4)).size, 0, 'four reports are too few to call anything boilerplate');
        const cluster = { terms: {}, entities: {} };
        for (const w of pool[0].sig.terms) cluster.terms[w] = 1;
        for (const w of pool[0].sig.entities) cluster.entities[w] = 1;
        assert.strictEqual(compare(pool[1].sig, cluster, 1).joins, true, 'without the pool, the boilerplate joins two different statements');
        assert.strictEqual(compare(pool[1].sig, cluster, 1, common).joins, false, 'with it, they stay apart');
    });

    await check('resplit regroups a polluted cluster: the unrelated report splits off, audited and reversible', async () => {
        const merged = await t.api(`/clusters/${main}/merge`, { json: { other: lone, reason: 'pollute it for the test' } });
        assert.strictEqual(merged.status, 200, merged.text);
        assert.strictEqual((await item(unrelated.id)).cluster_id, main);
        const dry = await t.ctx.clusters.resplit(null, main, { dryRun: true });
        assert.strictEqual(dry.groups, 2, JSON.stringify(dry.grouping));
        assert.strictEqual((await item(unrelated.id)).cluster_id, main, 'a dry run changes nothing');
        const r = await t.ctx.clusters.resplit(null, main);
        assert.strictEqual(r.splits.length, 1);
        assert.deepStrictEqual(r.splits[0].item_ids, [(await item(unrelated.id)).id], 'only the bakery report moves');
        assert.strictEqual(r.splits[0].action, 'split');
        assert.strictEqual(r.splits[0].actor, 'svc:news');
        assert.notStrictEqual((await item(unrelated.id)).cluster_id, main);
        assert.strictEqual((await item(reports.a.id)).cluster_id, main, 'the first report\'s group stays');
        assert.strictEqual((await t.ctx.clusters.resplit(null, main, { dryRun: true })).groups, 1, 'a clean cluster stays whole');
        const back = await t.api(`/clusters/audit/${r.splits[0].id}/reverse`, { json: { reason: 'undo the resplit' } });
        assert.strictEqual(back.status, 200, back.text);
        assert.strictEqual((await item(unrelated.id)).cluster_id, main);
    });

    await t.close();
    done();
})();
