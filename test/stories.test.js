'use strict';
/**
 * The editorial path: a story opened from a cluster, paragraphs that each cite sources, a story with
 * zero sources that cannot be published, publication with every claim traceable to Sources records
 * (page, JSON, citations table and the Search document), the timeline and perspectives, corrections
 * published with a revision, and non-editors refused.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done, launchReports } = require('./helpers/boot');

const BODY = [
    'NASA launched the Europa Clipper spacecraft on a Falcon Heavy rocket from Kennedy Space Center on Tuesday morning, starting a long cruise toward Jupiter and its icy moon Europa. [1, 2]',
    'According to NASA, the probe is scheduled to reach the Jupiter system in 2030, where it will fly past Europa dozens of times to study the ocean scientists believe lies beneath its ice shell. [2]',
    'Coverage from other outlets focused on why the mission matters for the search for places where life could exist beyond Earth. [3]',
].join('\n\n');

(async () => {
    const t = await boot();
    const reports = launchReports(t.sources);
    await t.pull();
    const clusterId = t.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id).cluster_id;
    const reader = t.network.addUser('reader');
    let story;

    await check('non-editors cannot open, write or publish stories (browser and service)', async () => {
        const r = await t.get('/api/v1/stories', { as: reader, json: { cluster: clusterId, headline: 'Nope' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'news.editor_required');
        const svc = t.network.serviceToken('live', ['news.story.create']);
        const s = await t.get('/api/v1/stories', { as: svc, json: { cluster: clusterId, headline: 'Nope' } });
        assert.strictEqual(s.status, 403, 'a service needs X-OV-Subject of an editor');
        const nocap = await t.get('/api/v1/stories', { as: t.network.serviceToken('live', []), json: { cluster: clusterId, headline: 'Nope' }, headers: { 'x-ov-subject': t.editor.subject } });
        assert.strictEqual(nocap.status, 403);
        assert.strictEqual(nocap.json().code, 'capability.denied');
    });

    await check('an editor opens a story from a cluster: the live, non-duplicate items become sources [1]..[3]', async () => {
        const r = await t.api('/stories', { json: { cluster: clusterId, headline: 'Europa Clipper launches for Jupiter', topic: 'space' } });
        assert.strictEqual(r.status, 201, r.text);
        story = r.json().story;
        assert.strictEqual(story.state, 'draft');
        assert.deepStrictEqual(story.sources.map((s) => [s.n, s.item.sources_item.id]), [[1, reports.a.id], [2, reports.b.id], [3, reports.c.id]]);
        assert.strictEqual(story.head, null);
        assert.strictEqual(t.events('news.story.created').length, 1);
    });

    await check('a paragraph without a source, or citing a number not in the source table, is refused', async () => {
        let r = await t.api(`/stories/${story.id}/revisions`, { json: { body: 'A claim with no source at all, which News must never publish.', expected_revision: 0 } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'story.claim_unsourced');
        r = await t.api(`/stories/${story.id}/revisions`, { json: { body: 'A claim citing a source that is not attached. [9]', expected_revision: 0 } });
        assert.strictEqual(r.json().code, 'story.unknown_source');
        assert.strictEqual(t.db().prepare('SELECT COUNT(*) AS n FROM news_story_revisions').get().n, 0);
    });

    await check('a story with zero sources cannot be published', async () => {
        const r = await t.api('/stories', { json: { headline: 'A story without any source' } });
        const lonely = r.json().story;
        assert.strictEqual(lonely.sources.length, 0);
        const rev = await t.api(`/stories/${lonely.id}/revisions`, { json: { body: 'Text. [1]', expected_revision: 0 } });
        assert.strictEqual(rev.status, 422, 'no [1] exists to cite');
        const pub = await t.api(`/stories/${lonely.id}/publish`, { json: {} });
        assert.strictEqual(pub.status, 422);
        assert.strictEqual(pub.json().code, 'story.no_text');
        assert.strictEqual(t.db().prepare("SELECT COUNT(*) AS n FROM news_stories WHERE state = 'published'").get().n, 0);
        const direct = t.ctx.stories.problems(t.ctx.stories.get(lonely.id), { number: 1, fields: { headline: 'x', paragraphs: [{ text: 'x', sources: [1] }], sources: [] }, meta: {} });
        assert.ok(direct.some((p) => p.code === 'story.unsourced'));
    });

    await check('revision 1 with cited paragraphs, a timeline entry and an editor-labelled perspective', async () => {
        let r = await t.api(`/stories/${story.id}/timeline`, { json: { occurred_on: '2026-09-22', text: 'Europa Clipper lifts off from Kennedy Space Center.', source: 1 } });
        assert.strictEqual(r.status, 201, r.text);
        r = await t.api(`/stories/${story.id}/timeline`, { json: { occurred_on: 'next spring', text: 'An invented date', source: 1 } });
        assert.strictEqual(r.json().code, 'timeline.invalid_date');
        r = await t.api(`/stories/${story.id}/perspectives`, { json: { label: 'Mission announcements', description: 'Reports built on NASA’s own statements.' } });
        const per = r.json().perspective;
        r = await t.api(`/stories/${story.id}/sources/${story.sources[1].item.id}/perspective`, { method: 'PUT', json: { perspective: per.id } });
        assert.strictEqual(r.status, 200, r.text);
        r = await t.api(`/stories/${story.id}/revisions`, { json: { body: BODY, expected_revision: 0 } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().revision, 1);
        const head = r.json().story.head;
        assert.deepStrictEqual(head.paragraphs.map((p) => p.sources), [[1, 2], [2], [3]]);
        assert.strictEqual(head.authorship.mode, 'human');
        assert.deepStrictEqual(r.json().story.publishable, []);
        const stale = await t.api(`/stories/${story.id}/revisions`, { json: { body: BODY.replace('Tuesday', 'Tuesday local time'), expected_revision: 0 } });
        assert.strictEqual(stale.status, 412, 'a stale base is a conflict, nothing is lost');
    });

    await check('publish: page, JSON, citations and the Search document all trace every claim to Sources records', async () => {
        const r = await t.api(`/stories/${story.id}/publish`, { json: {} });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().story.state, 'published');
        const page = await t.get('/stories/europa-clipper-launches-for-jupiter');
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /<h1>Europa Clipper launches for Jupiter<\/h1>/);
        assert.match(page.text, /<a href="#source-1" aria-label="source 1">1<\/a>/);
        assert.match(page.text, /<tr id="source-3">/);
        assert.match(page.text, /Wire A/);
        assert.match(page.text, /Ana Reporter/);
        assert.match(page.text, /<meta name="robots" content="index, follow">/);
        assert.strictEqual(page.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=60');
        assert.match(page.text, /"@type":"NewsArticle"/);
        assert.match(page.text, /Mission announcements/);
        assert.match(page.text, /2026-09-22<\/time> — Europa Clipper lifts off/);

        const json = (await t.get('/stories/europa-clipper-launches-for-jupiter.json')).json();
        assert.strictEqual(json.claims.length, 3);
        const byN = new Map(json.sources.map((s) => [s.n, s]));
        for (const c of json.claims) {
            assert.ok(c.sources.length >= 1);
            for (const n of c.sources) {
                const s = byN.get(n);
                assert.ok(s, `claim cites [${n}] which is in the source table`);
                assert.strictEqual(s.sources_item.service, 'sources');
                assert.ok(t.sources.items.find((i) => i.id === s.sources_item.id), `[${n}] resolves to a real Sources item`);
                assert.ok(s.url && s.headline && s.outlet);
            }
        }
        assert.deepStrictEqual(json.headline_sources, [1, 2]);
        assert.strictEqual(json.indexability.indexable, true);

        const cites = t.db().prepare('SELECT anchor, source_item_id FROM news_story_citations WHERE entity_id = ? AND revision = 1 ORDER BY id').all(story.id);
        assert.deepStrictEqual(cites.filter((c) => c.anchor.startsWith('p')).map((c) => `${c.anchor}:${c.source_item_id}`), [`p1:${reports.a.id}`, `p1:${reports.b.id}`, `p2:${reports.b.id}`, `p3:${reports.c.id}`]);

        const idx = t.events('news.index_document.upserted').pop();
        assert.ok(idx, 'Search gets the document');
        const doc = idx.payload;
        assert.ok(contracts.validate('search.index-document@1', doc).valid, JSON.stringify(contracts.validate('search.index-document@1', doc).errors));
        const prov = doc.provenance.filter((p) => p.service === 'sources').map((p) => p.id).sort();
        assert.deepStrictEqual(prov, [reports.a.id, reports.b.id, reports.c.id].sort());
        assert.strictEqual(doc.indexability.decision, 'index');
        const pub = t.events('news.story.published');
        assert.strictEqual(pub.length, 1);
        assert.strictEqual(pub[0].visibility, 'public');
        assert.strictEqual(pub[0].payload.canonical_url, 'https://openvibe.news/stories/europa-clipper-launches-for-jupiter');
        assert.strictEqual(pub[0].payload.topic, 'space');
    });

    await check('home, topic page, feeds and sitemap list the published story; its text reaches feeds, source summaries do not', async () => {
        const home = await t.get('/');
        assert.match(home.text, /Europa Clipper launches for Jupiter/);
        const topic = await t.get('/topics/space');
        assert.match(topic.text, /Europa Clipper launches for Jupiter/);
        const rss = await t.get('/feed.xml');
        assert.match(rss.text, /<guid isPermaLink="false">tag:openvibe.news,2026:story\/sty_/);
        assert.doesNotMatch(rss.text, /spacecraft lifted off/, 'a source summary is never fed');
        const tfeed = await t.get('/topics/space/feed.json');
        assert.strictEqual(tfeed.json().items.length, 1);
        const other = await t.get('/topics/games/feed.json');
        assert.strictEqual(other.json().items.length, 0);
        const sm = await t.get('/sitemaps/stories.xml');
        assert.match(sm.text, /<loc>https:\/\/openvibe.news\/stories\/europa-clipper-launches-for-jupiter<\/loc>/);
        const tm = await t.get('/sitemaps/topics.xml');
        assert.match(tm.text, /\/topics\/space/);
    });

    await check('a correction is published with the next revision and shows in the correction history', async () => {
        let r = await t.api(`/stories/${story.id}/revisions`, { json: { body: BODY.replace('dozens of times', 'about fifty times'), expected_revision: 1 } });
        assert.strictEqual(r.json().revision, 2);
        let page = await t.get('/stories/europa-clipper-launches-for-jupiter');
        assert.match(page.text, /dozens of times/, 'readers still see revision 1 until revision 2 is published');
        r = await t.api(`/stories/${story.id}/publish`, { json: { revision: 2, correction: { kind: 'correction', note: 'An earlier version said the probe would pass Europa “dozens of times”; NASA’s figure is about fifty.' } } });
        assert.strictEqual(r.status, 200, r.text);
        page = await t.get('/stories/europa-clipper-launches-for-jupiter');
        assert.match(page.text, /about fifty times/);
        assert.match(page.text, /<strong>Correction<\/strong>/);
        assert.match(page.text, /revision 2\): An earlier version said/);
        assert.strictEqual(t.events('news.story.updated').length, 1);
        const json = (await t.get('/stories/europa-clipper-launches-for-jupiter.json')).json();
        assert.strictEqual(json.corrections.length, 1);
        assert.strictEqual(json.revision, 2);
    });

    await check('reader framing: ?group=outlet and ?group=perspective re-frame the source table without JavaScript; canonical ignores it', async () => {
        const byOutlet = await t.get('/stories/europa-clipper-launches-for-jupiter?group=outlet');
        assert.match(byOutlet.text, /<h3>Paper B<\/h3>/);
        assert.match(byOutlet.text, /<link rel="canonical" href="https:\/\/openvibe.news\/stories\/europa-clipper-launches-for-jupiter">/);
        const byPer = await t.get('/stories/europa-clipper-launches-for-jupiter?group=perspective');
        assert.match(byPer.text, /<h3>Mission announcements<\/h3>/);
        assert.match(byPer.text, /<h3>Not grouped<\/h3>/);
        assert.match(byPer.text, /written by OpenVibe.News editors/);
    });

    await check('drafts are not public: never-published stories 404, the API hides them from readers', async () => {
        const r = await t.api('/stories', { json: { cluster: clusterId, headline: 'Second angle on the launch' } });
        const s = r.json().story;
        assert.strictEqual((await t.get(`/stories/${s.slug}`)).status, 404);
        assert.strictEqual((await t.get(`/api/v1/stories/${s.id}`)).status, 404);
        assert.strictEqual((await t.get(`/api/v1/stories/${s.id}`, { as: t.editor })).status, 200);
    });

    await check('unpublish takes the page down (410) and removes it from Search', async () => {
        const r = await t.api(`/stories/${story.id}/unpublish`, { json: {} });
        assert.strictEqual(r.json().story.state, 'unpublished');
        assert.strictEqual((await t.get('/stories/europa-clipper-launches-for-jupiter')).status, 410);
        assert.strictEqual(t.events('news.index_document.deleted').length, 1);
        assert.strictEqual(t.events('news.story.unpublished').length, 1);
        assert.doesNotMatch((await t.get('/sitemaps/stories.xml')).text, /europa-clipper-launches/);
    });

    await t.close();
    done();
})();
