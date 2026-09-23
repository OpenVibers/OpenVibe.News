'use strict';
/**
 * A retraction keeps the story visible at its URL with a retraction notice, makes it noindex
 * (meta robots, X-Robots-Tag and the gate's reason), removes it from sitemaps and Search (a
 * tombstone), labels it in listings and feeds, and emits news.story.retracted. A retraction needs a
 * note, only applies to a published story, and is final.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done, launchReports } = require('./helpers/boot');

const BODY = [
    'NASA launched the Europa Clipper spacecraft on a Falcon Heavy rocket from Kennedy Space Center, starting a cruise of several years toward Jupiter and its moon Europa. [1, 2]',
    'NASA expects the probe to reach the Jupiter system in 2030 and to fly past Europa many times to study the ocean scientists think lies beneath the ice. [2, 3]',
].join('\n\n');

(async () => {
    const t = await boot();
    const reports = launchReports(t.sources);
    await t.pull();
    const clusterId = t.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id).cluster_id;
    let r = await t.api('/stories', { json: { cluster: clusterId, headline: 'Europa Clipper heads for Jupiter', topic: 'space', body: BODY } });
    const story = r.json().story;
    await t.api(`/stories/${story.id}/publish`, { json: {} });
    const url = `/stories/${story.slug}`;

    await check('retraction needs a published story and a note', async () => {
        r = await t.api(`/stories/${story.id}/retract`, { json: { note: 'no' } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'story.retraction_note_required');
        const draft = (await t.api('/stories', { json: { cluster: clusterId, headline: 'A draft' } })).json().story;
        r = await t.api(`/stories/${draft.id}/retract`, { json: { note: 'Retracting a draft makes no sense at all.' } });
        assert.strictEqual(r.status, 409);
        const noCap = await t.get(`/api/v1/stories/${story.id}/retract`, { as: t.network.serviceToken('live', ['news.story.publish']), headers: { 'x-ov-subject': t.editor.subject }, json: { note: 'Service without the retract capability.' } });
        assert.strictEqual(noCap.status, 403);
    });

    await check('the retracted story stays at its URL with the notice, noindex, and its reason', async () => {
        r = await t.api(`/stories/${story.id}/retract`, { json: { note: 'The launch date reported in this story was wrong: our sources described a rehearsal, not the launch.' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().story.state, 'retracted');
        const page = await t.get(url);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /<div class="retraction" role="alert"><h2>Retracted<\/h2><p>The launch date reported in this story was wrong/);
        assert.match(page.text, /<title>Retracted: Europa Clipper heads for Jupiter/);
        assert.match(page.text, /<meta name="robots" content="noindex, follow">/);
        assert.strictEqual(page.headers.get('x-robots-tag'), 'noindex, follow');
        assert.match(page.text, /NASA launched the Europa Clipper spacecraft/, 'the text stays on the record');
        assert.match(page.text, /<strong>Retraction<\/strong>/);
        const json = (await t.get(`${url}.json`)).json();
        assert.strictEqual(json.state, 'retracted');
        assert.ok(json.retraction.note.startsWith('The launch date'));
        assert.deepStrictEqual(json.indexability.reasons.map((x) => x.code), ['retracted']);
    });

    await check('out of sitemaps and Search (tombstone), labelled in listings and feeds, event emitted', async () => {
        assert.doesNotMatch((await t.get('/sitemaps/stories.xml')).text, new RegExp(story.slug));
        const del = t.events('news.index_document.deleted');
        assert.strictEqual(del.length, 1);
        assert.strictEqual(del[0].payload.id, story.id);
        const ev = t.events('news.story.retracted');
        assert.strictEqual(ev.length, 1);
        assert.strictEqual(ev[0].payload.publication_state, 'retracted');
        assert.ok(ev[0].payload.note.startsWith('The launch date'));
        assert.ok(contracts.validate('events.event-envelope@1', { ...ev[0], event_id: 'evt_01J8Z3V9Q6N1X2Y3Z4A5B6C7D8' }).valid);
        const home = await t.get('/');
        assert.match(home.text, /badge-retracted/);
        const rss = await t.get('/feed.xml');
        assert.match(rss.text, /<title>Retracted: Europa Clipper heads for Jupiter<\/title>/);
        assert.match(rss.text, /This story was retracted: The launch date/);
    });

    await check('a retraction is final: no new revision or publication', async () => {
        r = await t.api(`/stories/${story.id}/revisions`, { json: { body: BODY, expected_revision: 1 } });
        assert.strictEqual(r.status, 409);
        r = await t.api(`/stories/${story.id}/publish`, { json: {} });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json().code, 'story.retracted');
    });

    await t.close();
    done();
})();
