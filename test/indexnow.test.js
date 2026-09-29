'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route, nothing
 * sent). With a key, the key file is served at /<key>.txt as text/plain and publishing an indexable
 * story pings the engines with the story's path and the sitemap. Drafts and noindex pages never ping.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const KEY = 'k'.repeat(32);
const PARA = 'Officials confirmed on Tuesday that the regional water authority will open two new treatment plants next spring, adding capacity for roughly 400,000 residents across the valley and ending the seasonal restrictions of recent summers. The authority said construction is on schedule and within the approved budget.';

/** An editor's story resting on exactly these Sources items (cited), published. */
async function storyOn(t, headline, items) {
    let r = await t.api('/stories', { json: { headline } });
    assert.strictEqual(r.status, 201, r.text);
    const story = r.json().story;
    for (const it of items) {
        r = await t.api(`/stories/${story.id}/sources`, { json: { item: it.id } });
        assert.ok(r.status === 200 || r.status === 201, r.text);
    }
    r = await t.api(`/stories/${story.id}/revisions`, { json: { body: `${PARA} [${items.map((_, i) => i + 1).join(', ')}]`, expected_revision: 0 } });
    assert.strictEqual(r.status, 201, r.text);
    r = await t.api(`/stories/${story.id}/publish`, { json: {} });
    assert.strictEqual(r.status, 200, r.text);
    return story;
}

(async () => {
    const off = await boot();
    await check('without a key IndexNow is off: no key route and nothing sent', async () => {
        assert.strictEqual(off.ctx.indexnow.enabled, false);
        const res = await off.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 404, res.text);
    });
    await off.close();

    const on = await boot({ env: { INDEXNOW_KEY: KEY } });
    await check('with a key the key file answers text/plain with the key', async () => {
        assert.strictEqual(on.ctx.indexnow.enabled, true);
        const res = await on.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 200, res.text);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        assert.strictEqual(res.text, KEY);
    });
    await on.close();

    // A spy in place of the module's HTTP send: records every pingSoon batch.
    const pings = [];
    const spy = {
        enabled: true,
        keyFile: (_req, _res, next) => next(),
        pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
        ping: async () => ({ sent: 0, status: 0 }),
        flush: async () => ({ sent: 0, status: 0 }),
    };
    const t = await boot({ indexnow: spy });
    t.sources.addSource('alpha-news', { name: 'Alpha News' });
    t.sources.addSource('solo-wire', { name: 'Solo Wire' });
    const alpha = t.sources.addItem({ source_key: 'alpha-news', title: 'Water agency says two new treatment plants will open next spring', url: 'https://alpha.example/a/water-agency-plants' });
    const solo = t.sources.addItem({ source_key: 'solo-wire', title: 'Water authority to open two treatment plants next spring', url: 'https://solo-wire.example/water/plants' });
    await t.pull();

    await check('a draft never pings', async () => {
        const r = await t.api('/stories', { json: { headline: 'A draft story about water' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(pings, []);
    });

    await check('a publish pings the page path and the sitemap', async () => {
        const story = await storyOn(t, 'Two new water treatment plants confirmed', [alpha, solo]);
        assert.ok(pings.includes(`https://openvibe.news/stories/${story.slug}`), JSON.stringify(pings));
        assert.ok(pings.includes('https://openvibe.news/sitemap.xml'), JSON.stringify(pings));
    });

    await check('a published but noindex story never pings', async () => {
        pings.length = 0;
        await storyOn(t, 'Two treatment plants to open next spring', [alpha]);
        assert.deepStrictEqual(pings, [], 'a noindex page is never pinged');
    });
    await t.close();

    done();
})().catch((err) => { console.error(err); process.exit(1); });
