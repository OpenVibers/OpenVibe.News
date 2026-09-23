'use strict';
/**
 * Upstream changes never change published text silently: a cited source revised or removed in
 * OpenVibe.Sources flags the story and prepares a pending revision; the published revision stays,
 * with a visible notice; a removed source's headline, summary and link leave the public page at
 * once; a revision still resting on it cannot be published; the editor's new revision, published
 * with a correction note, resolves the flags.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

const BODY = [
    'NASA launched the Europa Clipper spacecraft on a Falcon Heavy rocket from Kennedy Space Center, starting a cruise of several years toward Jupiter and its moon Europa. [1, 2]',
    'NASA expects the probe to reach the Jupiter system in 2030 and to fly past Europa many times to study the ocean scientists think lies beneath the ice. [2]',
    'One outlet reported that the launch window was chosen to use a gravity assist from Mars on the way to the outer planets, according to mission planners. [1]',
].join('\n\n');

(async () => {
    const t = await boot();
    const reports = launchReports(t.sources, { a: { summary: 'The Europa Clipper spacecraft lifted off on a Falcon Heavy rocket. ORIGINAL-SUMMARY-A.' } });
    await t.pull();
    const clusterId = t.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id).cluster_id;
    let r = await t.api('/stories', { json: { cluster: clusterId, headline: 'Europa Clipper is on its way to Jupiter', topic: 'space', body: BODY } });
    const story = r.json().story;
    r = await t.api(`/stories/${story.id}/publish`, { json: {} });
    assert.strictEqual(r.status, 200, r.text);
    const url = '/stories/europa-clipper-is-on-its-way-to-jupiter';
    const published = await t.get(url);

    await check('an upstream revision of a cited source: flag + pending revision; the published text is unchanged, with a notice', async () => {
        t.sources.updateItem(reports.b.id, { title: 'Europa Clipper lifts off; NASA now says arrival in 2031', summary: 'NASA revised its arrival estimate.' });
        await t.pull();
        const flags = t.db().prepare("SELECT * FROM news_editorial_flags WHERE story_id = ? AND kind = 'source_updated'").all(story.id);
        assert.strictEqual(flags.length, 1);
        assert.strictEqual(flags[0].status, 'open');
        assert.strictEqual(flags[0].pending_revision, 2);
        const rev2 = t.ctx.store.revisions.get(story.id, 2);
        assert.strictEqual(rev2.author, 'svc:news');
        assert.strictEqual(rev2.meta.system.reason, 'source_updated');
        assert.strictEqual(rev2.content, t.ctx.store.revisions.get(story.id, 1).content, 'the pending revision keeps the text for an editor to check');
        assert.strictEqual(rev2.fields.sources.find((s) => s.n === 2).headline, 'Europa Clipper lifts off; NASA now says arrival in 2031');
        const s = t.ctx.stories.get(story.id);
        assert.strictEqual(s.published_revision, 1, 'nothing was published by the system');
        const page = await t.get(url);
        assert.match(page.text, /changed after publication\. Editors are checking/);
        assert.match(page.text, /Europa Clipper lifts off as NASA begins long trip to Jupiter/, 'the source table still shows what revision 1 cited');
        const body = (h) => (h.match(/<div class="story-body">[\s\S]*?<\/div>/) || [null])[0];
        assert.ok(body(published.text));
        assert.strictEqual(body(page.text), body(published.text), 'the published paragraphs are byte-for-byte the same');
        assert.strictEqual(t.events('news.story.flagged').length, 1);
        assert.strictEqual(t.events('news.story.updated').length, 0);
    });

    await check('an upstream removal: flag + pending revision; the removed source’s headline, summary and link leave the page; noindex for unsupported claims', async () => {
        t.sources.removeItem(reports.a.id, 'licence withdrawn by the publisher');
        const d = await t.deliver({ event_type: 'sources.item.removed', subject: { type: 'item', id: reports.a.id, revision: 2 }, payload: { item_id: reports.a.id, source_key: 'wire-a', category: 'news', revision: 2, reason: 'licence withdrawn by the publisher' } });
        assert.strictEqual(d.status, 204, d.text);
        const item = t.db().prepare('SELECT * FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id);
        assert.strictEqual(item.status, 'removed');
        assert.strictEqual(item.summary, null, 'the licensed summary is dropped');
        const flag = t.db().prepare("SELECT * FROM news_editorial_flags WHERE story_id = ? AND kind = 'source_removed'").get(story.id);
        assert.strictEqual(flag.status, 'open');
        assert.strictEqual(flag.pending_revision, 3);
        const page = await t.get(url);
        assert.doesNotMatch(page.text, /ORIGINAL-SUMMARY-A/);
        assert.doesNotMatch(page.text, /wire-a\.example/);
        assert.doesNotMatch(page.text, /NASA launches Europa Clipper probe to Jupiter moon Europa/);
        assert.match(page.text, /this source was removed by the source registry/);
        assert.match(page.text, /was removed by the source registry after publication\. Editors are reviewing/);
        assert.match(page.text, /class="unsupported"/, 'the paragraph resting only on [1] is marked');
        assert.match(page.text, /<meta name="robots" content="noindex, follow">/);
        assert.match(page.headers.get('x-robots-tag'), /noindex/);
        const json = (await t.get(`${url}.json`)).json();
        assert.ok(json.indexability.reasons.some((x) => x.code === 'unsupported_claims'));
        assert.strictEqual(json.sources.find((s) => s.n === 1).headline, undefined);
        assert.strictEqual(json.claims[2].supported, false);
        assert.doesNotMatch(JSON.stringify(json), /ORIGINAL-SUMMARY-A|wire-a\.example/);
        const idx = t.events('news.index_document.upserted').pop();
        assert.strictEqual(idx.payload.indexability.decision, 'noindex', 'Search learns the story is noindex');
        assert.doesNotMatch((await t.get('/sitemaps/stories.xml')).text, /europa-clipper-is-on-its-way/);
        const replay = await t.deliver({ event_type: 'sources.item.removed', payload: { item_id: reports.a.id, reason: 'again' } });
        assert.strictEqual(replay.status, 204);
        assert.strictEqual(t.db().prepare("SELECT COUNT(*) AS n FROM news_editorial_flags WHERE kind = 'source_removed'").get().n, 1, 'a removal flags once');
    });

    await check('the editor desk shows the open flags, the pending revision and why it cannot be published', async () => {
        const desk = await t.get('/edit', { as: t.editor });
        assert.strictEqual(desk.status, 200);
        assert.match(desk.text, /source removed \(pending revision 3\)/);
        const edit = await t.get(`/edit/stories/${story.id}`, { as: t.editor });
        assert.strictEqual(edit.status, 200, edit.text);
        assert.match(edit.text, /<h2>Open flags<\/h2>/);
        assert.match(edit.text, /was prepared by the system because a source was removed upstream/);
        assert.match(edit.text, /<code>story.source_removed<\/code>/);
        assert.match(edit.text, /licence withdrawn by the publisher/, 'editors see the removal reason');
        const prev = await t.get(`/edit/stories/${story.id}/preview?revision=3`, { as: t.editor });
        assert.strictEqual(prev.status, 200);
        assert.match(prev.text, /Removed upstream: licence withdrawn/);
    });

    await check('the pending revision (still citing the removed source) cannot be published', async () => {
        r = await t.api(`/stories/${story.id}/publish`, { json: { revision: 3 } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json().code, 'story.source_removed');
        assert.strictEqual(t.ctx.stories.get(story.id).published_revision, 1);
    });

    await check('the editor revises without the removed source; publishing needs a correction note, then resolves both flags', async () => {
        // [1] leaves; the first paragraph now rests on [2] and [3], two independent outlets (the index gate needs two).
        const fixed = BODY.split('\n\n').slice(0, 2).map((p) => p.replace('[1, 2]', '[2, 3]')).join('\n\n');
        r = await t.api(`/stories/${story.id}/sources/${t.db().prepare('SELECT id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id).id}`, { method: 'DELETE' });
        assert.strictEqual(r.status, 200, r.text);
        r = await t.api(`/stories/${story.id}/revisions`, { json: { body: fixed.replace('2030', '2031'), expected_revision: 3 } });
        assert.strictEqual(r.status, 201, r.text);
        const n = r.json().revision;
        r = await t.api(`/stories/${story.id}/publish`, { json: { revision: n } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'story.correction_note_required');
        r = await t.api(`/stories/${story.id}/publish`, { json: { revision: n, correction: { kind: 'update', note: 'A source we cited withdrew its report, so the paragraph based only on it was removed; NASA now gives 2031 as the arrival year.' } } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().resolved_flags.length, 2);
        const open = t.db().prepare("SELECT COUNT(*) AS n FROM news_editorial_flags WHERE story_id = ? AND status = 'open'").get(story.id).n;
        assert.strictEqual(open, 0);
        const page = await t.get(url);
        assert.doesNotMatch(page.text, /Editors are (reviewing|checking)/);
        assert.match(page.text, /<strong>Update<\/strong>/);
        assert.match(page.text, /2031/);
        assert.match(page.text, /<meta name="robots" content="index, follow">/);
        assert.strictEqual(t.events('news.story.updated').length, 1);
    });

    await check('an unchanged upstream refetch (same revision) flags nothing', async () => {
        const before = t.db().prepare('SELECT COUNT(*) AS n FROM news_editorial_flags').get().n;
        t.ctx.store.setState('sources_cursor', 0);
        await t.pull();
        assert.strictEqual(t.db().prepare('SELECT COUNT(*) AS n FROM news_editorial_flags').get().n, before);
    });

    await t.close();
    done();
})();
