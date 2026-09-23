'use strict';
/**
 * The index gate needs independent sources: a story's paragraphs must cite at least
 * NEWS_MIN_INDEPENDENT_SOURCES (2) live sources that are not the same Sources source, the same
 * publisher's domain, the same outlet, or copies of one report. A story on fewer is published and
 * readable, but noindex ('unsourced'), out of the sitemaps, and Search is told it is noindex.
 * Setting the minimum to 1 restores the old behaviour.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const text = require('../server/domain/text');

const PARA = 'Officials confirmed on Tuesday that the regional water authority will open two new treatment plants next spring, adding capacity for roughly 400,000 residents across the valley and ending the seasonal restrictions of recent summers. The authority said construction is on schedule and within the approved budget.';

/** An editor's story resting on exactly these Sources items (cited in the one paragraph). */
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
    const t = await boot();
    const S = t.sources;
    S.addSource('solo-wire', { name: 'Solo Wire' });
    S.addSource('one-feed', { name: 'One Feed' });
    S.addSource('paper-world', { name: 'The Paper: World' });
    S.addSource('paper-tech', { name: 'The Paper: Tech' });
    S.addSource('alpha-news', { name: 'Alpha News' });
    S.addSource('beta-daily', { name: 'Beta Daily' });
    const solo = S.addItem({ source_key: 'solo-wire', title: 'Water authority to open two treatment plants next spring', url: 'https://solo-wire.example/water/plants' });
    const feed1 = S.addItem({ source_key: 'one-feed', title: 'Valley water restrictions to end as plants come online', url: 'https://one-feed.example/2026/valley-water' });
    const feed2 = S.addItem({ source_key: 'one-feed', title: 'Residents welcome news of added treatment capacity', url: 'https://one-feed.example/2026/residents-react' });
    const world = S.addItem({ source_key: 'paper-world', title: 'Regional authority approves treatment plant expansion', url: 'https://www.thepaper.example/world/plant-expansion' });
    const tech = S.addItem({ source_key: 'paper-tech', title: 'Inside the membrane technology behind the new plants', url: 'https://tech.thepaper.example/membranes' });
    const wire = S.addItem({ source_key: 'alpha-news', title: 'Water agency says two new treatment plants will open next spring', url: 'https://alpha.example/a/water-agency-plants' });
    const copy = S.addItem({ source_key: 'beta-daily', title: 'Water agency says two new treatment plants will open next spring', url: 'https://beta.example/b/syndicated-water' });
    const beta = S.addItem({ source_key: 'beta-daily', title: 'Budget vote clears way for valley water projects', url: 'https://beta.example/b/budget-vote' });
    await t.pull();
    const row = (it) => t.db().prepare('SELECT * FROM news_source_items WHERE sources_item_id = ?').get(it.id);
    const sitemap = async () => (await t.get('/sitemaps/stories.xml')).text;
    const indexEvent = (story) => t.events('news.index_document.upserted').filter((e) => e.payload.id === story.id).pop();

    await check('independence is concrete: same Sources source, same publisher domain, same outlet or a copy of one report count once', async () => {
        assert.strictEqual(text.publisherDomain('https://tech.thepaper.example/x'), 'thepaper.example');
        assert.strictEqual(text.publisherDomain('https://news.bbc.co.uk/x'), 'bbc.co.uk');
        assert.strictEqual(text.publisherDomain('https://www.bbc.co.uk/x'), 'bbc.co.uk');
        assert.strictEqual(row(copy).status, 'duplicate', 'the syndicated copy is a near-duplicate of the Alpha report');
        assert.strictEqual(row(copy).duplicate_of, row(wire).id);
        const n = (items) => text.independentSources(items.map(row)).length;
        assert.strictEqual(n([feed1, feed2]), 1);
        assert.strictEqual(n([world, tech]), 1);
        assert.strictEqual(n([wire, copy]), 1);
        assert.strictEqual(n([wire, copy, beta]), 1, 'the copy ties Beta Daily to the Alpha report: still one');
        assert.strictEqual(n([solo, wire]), 2);
        assert.strictEqual(n([solo, feed1, world, wire]), 4);
    });

    await check('a single-source story is published and readable but noindex, and absent from the sitemap', async () => {
        const story = await storyOn(t, 'Two treatment plants to open next spring', [solo]);
        const page = await t.get(`/stories/${story.slug}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /Officials confirmed on Tuesday/);
        assert.match(page.text, /<meta name="robots" content="noindex, follow">/);
        assert.strictEqual(page.headers.get('x-robots-tag'), 'noindex, follow');
        const json = (await t.get(`/stories/${story.slug}.json`)).json();
        assert.strictEqual(json.state, 'published');
        assert.deepStrictEqual(json.indexability.reasons.map((r) => [r.code, r.detail]), [['unsourced', '1 of 2 sources']]);
        assert.doesNotMatch(await sitemap(), new RegExp(story.slug));
        assert.strictEqual(indexEvent(story).payload.indexability.decision, 'noindex', 'Search is told it is noindex');
        assert.match((await t.get('/')).text, new RegExp(`href="/stories/${story.slug}"`), 'still listed for readers');
    });

    await check('two items from the same Sources source are one source: still noindex', async () => {
        const story = await storyOn(t, 'Valley water restrictions to end', [feed1, feed2]);
        const json = (await t.get(`/stories/${story.slug}.json`)).json();
        assert.strictEqual(json.sources.length, 2);
        assert.deepStrictEqual(json.indexability.reasons.map((r) => [r.code, r.detail]), [['unsourced', '1 of 2 sources']]);
        assert.doesNotMatch(await sitemap(), new RegExp(story.slug));
    });

    await check('two Sources sources of one publisher (one domain), or a report and its syndicated copy, are still noindex', async () => {
        const paper = await storyOn(t, 'Treatment plant expansion approved', [world, tech]);
        assert.deepStrictEqual((await t.get(`/stories/${paper.slug}.json`)).json().indexability.reasons.map((r) => r.code), ['unsourced']);
        const syndicated = await storyOn(t, 'Water agency confirms spring opening', [wire, copy]);
        assert.deepStrictEqual((await t.get(`/stories/${syndicated.slug}.json`)).json().indexability.reasons.map((r) => r.code), ['unsourced']);
        const sm = await sitemap();
        assert.doesNotMatch(sm, new RegExp(paper.slug));
        assert.doesNotMatch(sm, new RegExp(syndicated.slug));
    });

    await check('two independent sources make the story indexable and put it in the sitemap', async () => {
        const story = await storyOn(t, 'Two new water treatment plants confirmed', [solo, wire]);
        const page = await t.get(`/stories/${story.slug}`);
        assert.match(page.text, /<meta name="robots" content="index, follow">/);
        assert.strictEqual(page.headers.get('x-robots-tag'), null);
        assert.deepStrictEqual((await t.get(`/stories/${story.slug}.json`)).json().indexability, { indexable: true, robots: 'index, follow', reasons: [] });
        assert.match(await sitemap(), new RegExp(`<loc>https://openvibe.news/stories/${story.slug}</loc>`));
        assert.strictEqual(indexEvent(story).payload.indexability.decision, 'index');
    });
    await t.close();

    const one = await boot({ env: { NEWS_MIN_INDEPENDENT_SOURCES: '1' } });
    await check('NEWS_MIN_INDEPENDENT_SOURCES=1 restores the one-source gate', async () => {
        assert.strictEqual(one.ctx.publication.POLICY.minSources, 1);
        one.sources.addSource('solo-wire', { name: 'Solo Wire' });
        const it = one.sources.addItem({ source_key: 'solo-wire', title: 'Water authority to open two treatment plants next spring', url: 'https://solo-wire.example/water/plants' });
        await one.pull();
        const story = await storyOn(one, 'Two treatment plants to open next spring', [it]);
        const json = (await one.get(`/stories/${story.slug}.json`)).json();
        assert.strictEqual(json.indexability.indexable, true, JSON.stringify(json.indexability));
        assert.match((await one.get('/sitemaps/stories.xml')).text, new RegExp(story.slug));
    });
    await one.close();

    done();
})();
