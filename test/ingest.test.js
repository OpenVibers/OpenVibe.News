'use strict';
/**
 * Ingestion: the cursor pull and the Events webhook bring Sources items in exactly once; dedupe by
 * canonical URL, content hash and near-duplicate headlines; failures are recorded states that never
 * create a source item, a cluster or any story text.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const count = (table) => t.db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const byItm = (id) => t.db().prepare('SELECT * FROM news_source_items WHERE sources_item_id = ?').get(id);

    await check('only topics are seeded: no stories, source items or clusters exist on boot', async () => {
        assert.ok(count('news_topics') >= 10);
        for (const table of ['news_stories', 'news_source_items', 'news_story_clusters', 'news_story_revisions', 'news_editorial_flags']) assert.strictEqual(count(table), 0, table);
        const home = await t.get('/');
        assert.match(home.text, /No stories have been published yet/);
    });

    let reports;
    await check('the cursor pull ingests news items in change order and clusters them with an explanation', async () => {
        reports = launchReports(t.sources);
        t.sources.addItem({ source_key: 'blog-x', category: 'blog', title: 'A blog item that News must ignore' });
        const r = await t.pull();
        assert.ok(r.ok, JSON.stringify(r));
        assert.strictEqual(r.counts.created, 3);
        assert.strictEqual(count('news_source_items'), 3);
        const a = byItm(reports.a.id);
        const b = byItm(reports.b.id);
        const c = byItm(reports.c.id);
        assert.strictEqual(a.outlet, 'Wire A', 'outlet from the Sources registry name');
        assert.strictEqual(a.cluster_id, b.cluster_id);
        assert.strictEqual(a.cluster_id, c.cluster_id);
        const why = JSON.parse(b.cluster_reason);
        assert.strictEqual(why.rule, 'shared_terms');
        assert.ok(why.shared_entities.includes('europa clipper'), JSON.stringify(why));
        assert.ok(why.score >= 3);
        assert.strictEqual(t.ctx.store.getState('sources_cursor'), reports.c.change_seq);
        assert.strictEqual(t.events('news.source.ingested').length, 3);
        assert.ok(t.events('news.cluster.updated').length >= 3);
    });

    await check('a second pull (and a replayed page) changes nothing and emits nothing', async () => {
        const before = t.events().length;
        const r = await t.pull();
        assert.strictEqual(r.counts.created || 0, 0);
        t.ctx.store.setState('sources_cursor', 0);
        const again = await t.pull();
        assert.strictEqual(again.counts.unchanged, 3);
        assert.strictEqual(t.events().length, before);
        assert.strictEqual(count('news_source_items'), 3);
    });

    await check('dedupe: same canonical URL (tracking parameters and www. ignored) is a duplicate', async () => {
        const dup = t.sources.addItem({ source_key: 'paper-b', title: 'Europa Clipper launch: our live coverage', url: 'https://www.wire-a.example/space/europa-clipper-launch/?utm_source=x', published_at: '2026-09-22T11:00:00Z' });
        await t.pull();
        const row = byItm(dup.id);
        assert.strictEqual(row.status, 'duplicate');
        assert.strictEqual(row.duplicate_of, byItm(reports.a.id).id);
        assert.strictEqual(JSON.parse(row.dedupe).rule, 'canonical_url');
        assert.strictEqual(row.cluster_id, byItm(reports.a.id).cluster_id, 'a duplicate follows its original into the cluster');
    });

    await check('dedupe: identical Sources content hash is a duplicate', async () => {
        const dup = t.sources.addItem({ source_key: 'site-c', title: 'Syndicated copy', url: 'https://mirror.example/copy', content_hash: reports.b.provenance.content_hash });
        await t.pull();
        const row = byItm(dup.id);
        assert.strictEqual(row.status, 'duplicate');
        assert.strictEqual(JSON.parse(row.dedupe).rule, 'content_hash');
        assert.strictEqual(row.duplicate_of, byItm(reports.b.id).id);
    });

    await check('dedupe: a near-identical headline (2-shingle Jaccard) within 48 h is a duplicate; a different story is not', async () => {
        const near = t.sources.addItem({ source_key: 'wire-a', title: 'NASA launches Europa Clipper probe to Jupiter moon Europa, officials say', url: 'https://wire-a.example/space/europa-clipper-launch-updated', published_at: '2026-09-22T12:00:00Z' });
        const other = t.sources.addItem({ source_key: 'paper-b', title: 'City council approves new bike lanes downtown', url: 'https://paper-b.example/bike-lanes', published_at: '2026-09-22T12:00:00Z' });
        await t.pull();
        const n = byItm(near.id);
        assert.strictEqual(n.status, 'duplicate', JSON.stringify(n));
        assert.strictEqual(JSON.parse(n.dedupe).rule, 'near_title');
        assert.match(JSON.parse(n.dedupe).detail, /jaccard 0\.\d\d/);
        const o = byItm(other.id);
        assert.strictEqual(o.status, 'active');
        assert.notStrictEqual(o.cluster_id, byItm(reports.a.id).cluster_id, 'an unrelated story starts its own cluster');
        assert.strictEqual(JSON.parse(o.cluster_reason).rule, 'new_cluster');
    });

    await check('a failed pull is recorded, relayed once per outage, and creates nothing', async () => {
        const items = count('news_source_items');
        const clusters = count('news_story_clusters');
        t.sources.addItem({ source_key: 'wire-a', title: 'Arrives while Sources is down' });
        t.sources.setDown(true);
        const r1 = await t.pull();
        const r2 = await t.pull();
        assert.strictEqual(r1.ok, false);
        assert.strictEqual(r2.ok, false);
        assert.strictEqual(count('news_source_items'), items);
        assert.strictEqual(count('news_story_clusters'), clusters);
        assert.strictEqual(count('news_stories'), 0);
        const runs = t.db().prepare("SELECT * FROM news_ingest_runs WHERE origin = 'pull' AND state = 'failed'").all();
        assert.strictEqual(runs.length, 2);
        assert.strictEqual(t.events('news.source.failed').filter((e) => e.payload.origin === 'pull').length, 1);
        const ready = await t.get('/api/ready');
        assert.match(ready.text, /last pull failed/);
        t.sources.setDown(false);
        const r3 = await t.pull();
        assert.ok(r3.ok);
        assert.strictEqual(count('news_source_items'), items + 1);
    });

    await check('webhook: a signed sources.item.created is applied once; a redelivery changes nothing', async () => {
        const it = t.sources.addItem({ source_key: 'site-c', title: 'Europa Clipper team describes first weeks of cruise to Jupiter', url: 'https://site-c.example/cruise', published_at: '2026-09-22T12:30:00Z' });
        const ev = { event_type: 'sources.item.created', subject: { type: 'item', id: it.id, revision: 1 }, payload: { item_id: it.id, source_key: 'site-c', category: 'news', revision: 1 } };
        const r = await t.deliver(ev);
        assert.strictEqual(r.status, 204, r.text + JSON.stringify(t.db().prepare('SELECT * FROM news_ingest_runs ORDER BY id DESC LIMIT 1').get()));
        assert.ok(byItm(it.id));
        const n = t.events('news.source.ingested').length;
        const again = await fetch(`${t.base}/internal/events`, { method: 'POST', headers: r.headers, body: r.body });
        assert.strictEqual(again.status, 204);
        assert.strictEqual(t.events('news.source.ingested').length, n);
        const pulled = await t.pull();
        assert.strictEqual(pulled.counts.created || 0, 0, 'the pull backstop sees it as already applied');
    });

    await check('webhook: bad signature, v1-only and stale v2 are 401; events from other producers ignored', async () => {
        const r = await t.deliver({ event_type: 'sources.item.created', payload: {} }, { secret: 'wrong-secret-wrong-secret-wrong-secret' });
        assert.strictEqual(r.status, 401);
        const v1only = await t.deliver({ event_type: 'blog.post.published', source: 'blog', payload: {} }, { v1Only: true });
        assert.strictEqual(v1only.status, 401, 'v1 only (no v2 header): refused');
        const stale = await t.deliver({ event_type: 'blog.post.published', source: 'blog', payload: {} }, { now: Date.now() - 301000 });
        assert.strictEqual(stale.status, 401, 'stale v2 (outside the 300 s window): refused');
        const other = await t.deliver({ event_type: 'blog.post.published', source: 'blog', payload: {} });
        assert.strictEqual(other.status, 204);
        const forged = await t.deliver({ event_type: 'sources.item.removed', source: 'blog', payload: { item_id: reports.a.id, reason: 'forged' } });
        assert.strictEqual(forged.status, 204);
        assert.strictEqual(byItm(reports.a.id).status, 'active', 'only source "sources" may remove an item');
    });

    await check('webhook: when Sources cannot be read the delivery is 503 (retried), recorded, relayed once, and nothing is made', async () => {
        const it = t.sources.addItem({ source_key: 'wire-a', title: 'Delivered while Sources is unreachable' });
        t.sources.setDown(true);
        const before = count('news_source_items');
        const failedBefore = t.events('news.source.failed').length;
        const ev = { event_type: 'sources.item.created', payload: { item_id: it.id, source_key: 'wire-a', category: 'news', revision: 1 } };
        const r1 = await t.deliver(ev, { attempt: 1 });
        const r2 = await t.deliver(ev, { attempt: 2 });
        assert.strictEqual(r1.status, 503);
        assert.strictEqual(r2.status, 503);
        assert.strictEqual(count('news_source_items'), before);
        assert.strictEqual(t.events('news.source.failed').length, failedBefore + 1);
        assert.ok(t.db().prepare("SELECT COUNT(*) AS n FROM news_ingest_runs WHERE origin = 'webhook' AND state = 'failed'").get().n >= 2);
        t.sources.setDown(false);
    });

    await check('sources.fetch.failed for a news source is recorded and relayed; no text is fabricated', async () => {
        const stories = count('news_stories');
        const items = count('news_source_items');
        const r = await t.deliver({ event_type: 'sources.fetch.failed', subject: { type: 'source', id: 'wire-a' }, payload: { source_key: 'wire-a', category: 'news', run_id: 'run_9', state: 'timeout', error_code: 'fetch.timeout', http_status: null, consecutive_failures: 3 } });
        assert.strictEqual(r.status, 204);
        const run = t.db().prepare("SELECT * FROM news_ingest_runs WHERE origin = 'sources' ORDER BY id DESC").get();
        assert.strictEqual(run.state, 'timeout');
        assert.strictEqual(run.source_key, 'wire-a');
        const ev = t.events('news.source.failed').pop();
        assert.strictEqual(ev.payload.origin, 'sources');
        assert.strictEqual(ev.payload.state, 'timeout');
        assert.strictEqual(count('news_stories'), stories);
        assert.strictEqual(count('news_source_items'), items);
        const desk = await t.get('/edit', { as: t.editor });
        assert.match(desk.text, /timeout/);
    });

    await check('an item without a title is rejected and recorded, never shown', async () => {
        const it = t.sources.addItem({ source_key: 'wire-a', title: '' });
        await t.pull();
        assert.strictEqual(byItm(it.id), undefined);
        assert.ok(t.db().prepare("SELECT COUNT(*) AS n FROM news_ingest_runs WHERE state = 'rejected' AND sources_item_id = ?").get(it.id).n === 1);
    });

    await t.close();
    done();
})();
