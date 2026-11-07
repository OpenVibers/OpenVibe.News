'use strict';
/**
 * Sharing on News stories (design 2026-11-06, VISIBILITY-EVERYWHERE step 4; openvibe-sdk/share).
 * A draft is Only me; its editor can name someone ("look at this before I post it"). The story page
 * answers a stranger with the gate, never the headline or the text. Published stories are Everyone.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const reader = t.network.addUser('rita');
    const mate = t.network.addUser('milo');
    const stranger = t.network.addUser('sam');
    const share = (id, o = {}) => t.get(`/api/v1/story/${id}/share`, { as: t.editor, headers: { 'x-requested-with': 'ov-share' }, ...o });
    const putShare = (id, body) => share(id, { method: 'PUT', json: body });

    const reports = launchReports(t.sources, { a: { fields: { body: 'Report A' } } });
    await t.pull();
    const clusterId = (await t.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id)).cluster_id;
    const make = async () => {
        const r = await t.api('/stories', { json: { cluster: clusterId, headline: 'The LOOI bridge notes' } });
        assert.strictEqual(r.status, 201, r.text);
        const story = r.json().story;
        const rev = await t.api(`/stories/${story.id}/revisions`, { json: { paragraphs: [{ text: 'SECRET-LOOI text about a bridge and the words around it. [1]', sources: [1] }], expected_revision: 0 } });
        assert.strictEqual(rev.status, 201, rev.text);
        return story;
    };
    const row = async (id) => await t.db().prepare('SELECT * FROM shares WHERE service = ? AND kind = ? AND resource_id = ?').get('news', 'story', id);

    await check('a new story is a draft, registered Only me and owned by its editor', async () => {
        const story = await make();
        const s = await row(story.id);
        assert.strictEqual(s.audience, 'private');
        assert.deepStrictEqual(s.owner_subject, { type: 'user', id: t.editor.subject });
        assert.strictEqual((await t.get(`/stories/${story.slug}`, { as: t.editor })).status, 200);
        assert.strictEqual((await t.get(`/stories/${story.slug}`, { as: reader })).status, 404);
        assert.strictEqual((await t.get(`/stories/${story.slug}`)).status, 404);
    });

    await check('Specific people: the named person reads the draft; a stranger gets the gate and no headline', async () => {
        const story = await make();
        const put = await putShare(story.id, { audience: 'people', members: [{ subject: { type: 'user', id: reader.subject }, role: 'viewer' }] });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual(put.json().audience, 'people');
        const member = await t.get(`/stories/${story.slug}`, { as: reader });
        assert.strictEqual(member.status, 200);
        assert.ok(member.text.includes('SECRET-LOOI'));
        const strangerPage = await t.get(`/stories/${story.slug}`, { as: stranger });
        assert.strictEqual(strangerPage.status, 404);
        assert.ok(strangerPage.text.includes('shared with specific people') && strangerPage.text.includes('data-ov-share-gate'));
        assert.ok(!strangerPage.text.includes('The LOOI bridge notes'), 'no headline');
        const anon = await t.get(`/stories/${story.slug}`);
        assert.strictEqual(anon.status, 404);
        assert.ok(anon.text.includes('/auth/login?next='));
        assert.strictEqual((await t.get(`/api/v1/story/${story.id}/share`, { as: stranger })).status, 404, 'the sheet is the editor’s');
    });

    await check('the sheet offers the four audiences; the editor keeps reading the draft either way', async () => {
        const story = await make();
        const sheet = await share(story.id);
        assert.strictEqual(sheet.status, 200);
        assert.deepStrictEqual(sheet.json().audiences, ['public', 'link', 'people', 'private']);
        await putShare(story.id, { audience: 'private' });
        assert.strictEqual((await row(story.id)).audience, 'private');
        assert.strictEqual((await t.get(`/stories/${story.slug}`, { as: t.editor })).status, 200);
        assert.strictEqual((await t.get(`/stories/${story.slug}`, { as: mate })).status, 404);
    });

    await done();
    await t.close();
})();
