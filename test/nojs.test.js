'use strict';
/**
 * Useful without JavaScript: the whole editorial journey with plain HTML forms (Network SSO
 * cookies and form tokens), and public pages whose content is complete in the HTML — no script is
 * needed to read a story, its sources, timeline, perspectives or corrections.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

const BODY = [
    'NASA launched the Europa Clipper spacecraft on a Falcon Heavy rocket from Kennedy Space Center, starting a cruise of several years toward Jupiter and its moon Europa. [1, 2]',
    'Reports differ on emphasis: one outlet focused on the rocket and the launch itself, another on when the probe will arrive at Jupiter and what it will study there. [1, 2, 3]',
].join('\n\n');

(async () => {
    const t = await boot();
    const reports = launchReports(t.sources);
    await t.pull();
    const clusterId = t.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id).cluster_id;
    const ed = t.editor;
    const csrf = t.csrf(ed);
    let storyId;
    const loc = (r) => r.headers.get('location') || '';

    await check('the desk sends a signed-out browser to Network sign-in and refuses non-editors', async () => {
        const r = await t.get('/edit');
        assert.strictEqual(r.status, 303);
        assert.strictEqual(loc(r), '/auth/login?next=%2Fedit');
        const login = await t.get('/auth/login?next=/edit');
        assert.strictEqual(login.status, 302);
        assert.match(loc(login), /\/oauth\/authorize\?.*client_id=news/);
        const reader = await t.get('/edit', { as: t.network.addUser('someone') });
        assert.strictEqual(reader.status, 403);
        assert.match(reader.text, /Editors only/);
    });

    await check('the desk lists clusters and ingestion status; a form without the token is refused', async () => {
        const desk = await t.get('/edit', { as: ed });
        assert.strictEqual(desk.status, 200);
        assert.match(desk.text, new RegExp(`href="/clusters/${clusterId}"`));
        assert.strictEqual(desk.headers.get('cache-control'), 'private, no-store');
        assert.match(desk.headers.get('x-robots-tag'), /noindex/);
        const r = await t.get(`/clusters/${clusterId}/stories`, { as: ed, form: { headline: 'No token' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(t.db().prepare('SELECT COUNT(*) AS n FROM news_stories').get().n, 0);
    });

    await check('open a story from the cluster page, then write paragraphs with [n] markers', async () => {
        const page = await t.get(`/clusters/${clusterId}`, { as: ed });
        assert.match(page.text, new RegExp(`<form method="post" action="/clusters/${clusterId}/stories"`));
        let r = await t.get(`/clusters/${clusterId}/stories`, { as: ed, form: { _csrf: csrf, headline: 'Europa Clipper begins its trip to Jupiter', topic: 'space' } });
        assert.strictEqual(r.status, 303, r.text);
        storyId = (loc(r).match(/\/edit\/stories\/(sty_[0-9A-Z]+)/) || [])[1];
        assert.ok(storyId, loc(r));
        const edit = await t.get(`/edit/stories/${storyId}`, { as: ed });
        assert.match(edit.text, /<textarea id="body" name="body"/);
        assert.match(edit.text, /name="expectedRevision" value="0"/);
        r = await t.get(`/edit/stories/${storyId}/revise`, { as: ed, form: { _csrf: csrf, expectedRevision: '0', headline: 'Europa Clipper begins its trip to Jupiter', body: 'An uncited sentence.', topic: 'space' } });
        assert.strictEqual(r.status, 422);
        assert.match(r.text, /cites no source/);
        r = await t.get(`/edit/stories/${storyId}/revise`, { as: ed, form: { _csrf: csrf, expectedRevision: '0', headline: 'Europa Clipper begins its trip to Jupiter', body: BODY, topic: 'space', noindex: '0' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.match(decodeURIComponent(loc(r)), /Saved revision 1/);
    });

    await check('timeline, perspective and grouping with forms; a second revision snapshots them', async () => {
        let r = await t.get(`/edit/stories/${storyId}/timeline`, { as: ed, form: { _csrf: csrf, occurredOn: '2026-09-22', text: 'Launch from Kennedy Space Center.', source: '1' } });
        assert.strictEqual(r.status, 303, r.text);
        r = await t.get(`/edit/stories/${storyId}/perspective`, { as: ed, form: { _csrf: csrf, label: 'Launch coverage', description: 'Reports about the launch itself.' } });
        assert.strictEqual(r.status, 303);
        const per = t.db().prepare('SELECT id FROM news_perspectives WHERE story_id = ?').get(storyId).id;
        const item = t.db().prepare('SELECT id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id).id;
        r = await t.get(`/edit/stories/${storyId}/assign`, { as: ed, form: { _csrf: csrf, item, perspective: per } });
        assert.strictEqual(r.status, 303);
        r = await t.get(`/edit/stories/${storyId}/revise`, { as: ed, form: { _csrf: csrf, expectedRevision: '1', headline: 'Europa Clipper begins its trip to Jupiter', body: BODY, topic: 'space' } });
        assert.match(decodeURIComponent(loc(r)), /Saved revision 2/);
        const stale = await t.get(`/edit/stories/${storyId}/revise`, { as: ed, form: { _csrf: csrf, expectedRevision: '1', headline: 'x', body: BODY } });
        assert.strictEqual(stale.status, 412);
        assert.match(stale.text, /Someone saved revision 2 while you were editing/);
    });

    await check('preview, publish with the form, and read the public page with no JavaScript', async () => {
        const prev = await t.get(`/edit/stories/${storyId}/preview?revision=2`, { as: ed });
        assert.strictEqual(prev.status, 200);
        assert.match(prev.text, /preview of revision 2/);
        assert.strictEqual(prev.headers.get('cache-control'), 'private, no-store');
        let r = await t.get(`/edit/stories/${storyId}/publish`, { as: ed, form: { _csrf: csrf, revision: '2', correctionKind: '', correctionNote: '' } });
        assert.strictEqual(r.status, 303, r.text);
        const page = await t.get('/stories/europa-clipper-begins-its-trip-to-jupiter');
        assert.strictEqual(page.status, 200);
        const withoutScripts = page.text.replace(/<script[\s\S]*?<\/script>/g, '');
        for (const needle of ['<h1>Europa Clipper begins its trip to Jupiter</h1>', 'NASA launched the Europa Clipper spacecraft', '<h2 id="sources-h">Sources</h2>',
            'Launch from Kennedy Space Center.', '<h2 id="persp-h">Perspectives</h2>', 'Launch coverage', '<h2 id="corr-h">Corrections and updates</h2>', 'href="?group=outlet#sources"', 'Wire A', 'Paper B', 'Site C']) {
            assert.ok(withoutScripts.includes(needle), `missing without JS: ${needle}`);
        }
        assert.match(page.text, /<noscript>/);
        assert.match(page.text, /<link rel="alternate" type="application\/rss\+xml"/);
        r = await t.get(`/edit/stories/${storyId}/flag`, { as: ed, form: { _csrf: csrf, kind: 'update', note: 'Added the timeline entry for the launch.' } });
        assert.strictEqual(r.status, 303);
    });

    await check('the editor’s diff page and the revisions list work as plain links', async () => {
        const diff = await t.get(`/edit/stories/${storyId}/diff?from=1&to=2`, { as: ed });
        assert.strictEqual(diff.status, 200);
        assert.match(diff.text, /Revision 1 → 2/);
        assert.match(diff.text, /Changed fields: .*perspectives/);
        const edit = await t.get(`/edit/stories/${storyId}`, { as: ed });
        assert.match(edit.text, /readers see revision 2/);
        assert.match(edit.text, /Search engines: indexable/);
    });

    await t.close();
    done();
})();
