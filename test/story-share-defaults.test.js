'use strict';
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const make = async (headline) => {
        const r = await t.api('/stories', { json: { headline } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json().story;
    };
    const save = (audience, apply = false, extra = {}) => t.get('/edit/share-default', {
        as: t.editor, method: 'POST', form: { _csrf: t.csrf(t.editor), audience, ...(apply ? { apply: '1' } : {}) }, ...extra,
    });
    try {
        await check('the editor desk saves a personal draft default; new drafts can override it', async () => {
            const desk = await t.get('/edit', { as: t.editor });
            assert.strictEqual(desk.status, 200);
            assert.ok(desk.text.includes('Apply to all my existing drafts'));
            assert.strictEqual(await t.ctx.sharing.defaultAudience(t.editor.subject), 'private');
            assert.strictEqual((await save('people')).status, 303);
            assert.strictEqual(await t.ctx.sharing.defaultAudience(t.editor.subject), 'people');
            const draft = await make('A draft for named readers');
            assert.strictEqual((await t.ctx.sharing.shareOf(draft.id)).audience, 'people');
            const stranger = t.network.addUser('stranger');
            const gate = await t.get(`/stories/${draft.slug}`, { as: stranger });
            assert.strictEqual(gate.status, 404);
            assert.ok(gate.text.includes('data-ov-share-gate') && !gate.text.includes(draft.working_headline));
            const override = await t.get(`/api/v1/story/${draft.id}/share`, {
                as: t.editor, method: 'PUT', json: { audience: 'private' }, headers: { 'x-requested-with': 'ov-share' },
            });
            assert.strictEqual(override.status, 200, override.text);
            assert.strictEqual((await t.ctx.sharing.shareOf(draft.id)).audience, 'private');
        });

        await check('apply to all changes this editor’s drafts, not published or another editor’s story', async () => {
            await save('private');
            const own = await make('Own unfinished story');
            const published = await make('Published editorial story');
            const other = await make('Someone else owns this draft');
            const nextOwner = t.network.addUser('another-editor');
            await t.db().exec("UPDATE news_stories SET state = 'published' WHERE id = $1", [published.id]);
            await t.ctx.sharing.syncAudience(published.id, 'public');
            await t.db().exec('UPDATE news_stories SET created_by = $1 WHERE id = $2', [nextOwner.subject, other.id]);
            await t.db().exec("UPDATE shares SET owner_subject = $1::jsonb WHERE service = 'news' AND kind = 'story' AND resource_id = $2",
                [JSON.stringify({ type: 'user', id: nextOwner.subject }), other.id]);
            const applied = await save('people', true);
            assert.strictEqual(applied.status, 303, applied.text);
            assert.strictEqual((await t.ctx.sharing.shareOf(own.id)).audience, 'people');
            assert.strictEqual((await t.ctx.sharing.shareOf(published.id)).audience, 'public');
            assert.strictEqual((await t.ctx.sharing.shareOf(other.id)).audience, 'private');
        });

        await check('invalid default and missing form token are refused', async () => {
            assert.strictEqual((await save('public')).status, 422);
            assert.strictEqual((await save('private', false, { form: { _csrf: 'wrong', audience: 'private' } })).status, 403);
        });

        await check('a published story leaving Everyone drops from lists and Search while its link stays readable', async () => {
            const reports = launchReports(t.sources);
            await t.pull();
            const cluster = await t.db().maybe('SELECT cluster_id FROM news_source_items WHERE sources_item_id = $1', [reports.a.id]);
            const created = await t.api('/stories', { json: { cluster: cluster.cluster_id, headline: 'Visibility Example for sharing' } });
            assert.strictEqual(created.status, 201, created.text);
            const story = created.json().story;
            const body = [
                'NASA launched the Europa Clipper spacecraft on a Falcon Heavy rocket from Kennedy Space Center on Tuesday morning, starting a long cruise toward Jupiter and its icy moon Europa. [1, 2]',
                'The mission is scheduled to reach Jupiter in 2030, and scientists expect the probe to fly past Europa many times to study the ocean beneath its ice shell. [2, 3]',
            ].join('\n\n');
            const revised = await t.api(`/stories/${story.id}/revisions`, { json: { body, expected_revision: 0 } });
            assert.strictEqual(revised.status, 201, revised.text);
            const published = await t.api(`/stories/${story.id}/publish`, { json: {} });
            assert.strictEqual(published.status, 200, published.text);
            assert.ok((await t.get('/')).text.includes('Visibility Example for sharing'));
            const narrowed = await t.get(`/api/v1/story/${story.id}/share`, {
                as: t.editor, method: 'PUT', json: { audience: 'link' }, headers: { 'x-requested-with': 'ov-share' },
            });
            assert.strictEqual(narrowed.status, 200, narrowed.text);
            assert.strictEqual((await t.db().maybe('SELECT audience FROM news_stories WHERE id = $1', [story.id])).audience, 'private');
            assert.ok(!(await t.get('/')).text.includes('Visibility Example for sharing'));
            assert.ok(!(await t.get('/sitemaps/stories.xml')).text.includes(story.slug));
            const direct = await t.get(`/stories/${story.slug}`);
            assert.strictEqual(direct.status, 200);
            assert.ok(direct.headers.get('cache-control').includes('no-store'));
            assert.ok(direct.text.includes('noindex'));
            assert.ok((await t.events('news.index_document.deleted')).length >= 1);
            const privateShare = await t.get(`/api/v1/story/${story.id}/share`, {
                as: t.editor, method: 'PUT', json: { audience: 'people' }, headers: { 'x-requested-with': 'ov-share' },
            });
            assert.strictEqual(privateShare.status, 200, privateShare.text);
            assert.strictEqual((await t.get(`/api/v1/stories/${story.id}`)).status, 404);
            const outsider = t.network.addUser('comment-outsider');
            assert.strictEqual((await t.get(`/stories/${story.slug}/comments`, { as: outsider, method: 'POST', form: { message: 'test' } })).status, 404);
        });
    } finally { await t.close(); }
    done();
})().catch((error) => { console.error(error); process.exit(1); });
