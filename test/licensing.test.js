'use strict';
/**
 * Licensed material never leaks: whatever a Sources item carries beyond headline, URL, outlet,
 * authors and date — an article body an adapter mapped into `fields`, a long summary — never
 * reaches News' database, public pages, JSON, feeds, sitemaps, the API, events or the Search
 * document. A short summary is kept only when the item's terms or licence note allows short
 * summaries, and then only up to NEWS_SUMMARY_MAX_CHARS.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { licensedSummary } = require('../server/domain/text');

const BODY_SENTINEL = 'SECRET-FULL-ARTICLE-BODY-7f3a';
const TAIL_SENTINEL = 'SECRET-SUMMARY-TAIL-91c2';
const FORBIDDEN_SENTINEL = 'SECRET-SUMMARY-FORBIDDEN-44de';
const UNLICENSED_SENTINEL = 'SECRET-SUMMARY-NO-TERMS-0b8e';
const longBody = `${BODY_SENTINEL} ${'The full article text goes on and on. '.repeat(200)}`;

(async () => {
    await check('the licensing rule: only an explicit allowance keeps a summary, capped at a word boundary', async () => {
        assert.deepStrictEqual(licensedSummary('Short one.', { termsNote: 'Titles, links and short summaries only.' }), { summary: 'Short one.', basis: 'terms_allow_short_summaries' });
        assert.strictEqual(licensedSummary('x', { termsNote: 'Headlines and links only.' }).summary, null);
        assert.strictEqual(licensedSummary('x', { termsNote: 'No summaries may be republished.' }).basis, 'terms_forbid_summaries');
        assert.strictEqual(licensedSummary('x', { termsNote: null, licenseNote: null }).basis, 'terms_do_not_allow_summaries');
        const cut = licensedSummary(`${'word '.repeat(100)}END`, { termsNote: 'brief summaries are allowed', maxChars: 50 });
        assert.ok(cut.summary.length <= 50 && cut.summary.endsWith('…'), cut.summary);
        assert.strictEqual(licensedSummary('x', { termsNote: 'short summaries', maxChars: 0 }).summary, null);
    });

    const t = await boot();
    t.sources.addSource('wire-a', { name: 'Wire A' });
    t.sources.addSource('paper-b', { name: 'Paper B' });
    t.sources.addSource('site-c', { name: 'Site C' });
    const allowed = t.sources.addItem({
        source_key: 'wire-a', title: 'Europa Clipper launch delayed by storms over Florida', url: 'https://wire-a.example/europa-delay',
        summary: `Storms delayed the Europa Clipper launch. ${'More detail follows here in the long feed summary. '.repeat(10)}${TAIL_SENTINEL}`,
        terms_note: 'Titles, links and short summaries only; link back.', fields: { body: longBody, content: longBody, article_text: longBody },
        published_at: '2026-09-22T08:00:00Z', authors: ['Ana Reporter'],
    });
    const forbidden = t.sources.addItem({
        source_key: 'paper-b', title: 'Europa Clipper launch slips after Florida storms, NASA says', url: 'https://paper-b.example/europa-slips',
        summary: `${FORBIDDEN_SENTINEL} NASA said the launch would move.`, terms_note: 'Headlines and links only; no summaries.', fields: { body: longBody },
        published_at: '2026-09-22T08:30:00Z',
    });
    const unlicensed = t.sources.addItem({
        source_key: 'site-c', title: 'Florida storms push back NASA Europa Clipper launch', url: 'https://site-c.example/europa-storms',
        summary: `${UNLICENSED_SENTINEL} The launch team stood down.`, terms_note: null, license_note: null, fields: { html: `<p>${longBody}</p>` },
        published_at: '2026-09-22T09:00:00Z',
    });
    await t.pull();
    const clusterId = t.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(allowed.id).cluster_id;
    let r = await t.api('/stories', { json: { cluster: clusterId, headline: 'Storms delay Europa Clipper launch', topic: 'space', body: [
        'Storms over Florida delayed the launch of NASA’s Europa Clipper mission, according to reports from three outlets that covered the countdown at Kennedy Space Center. [1, 2, 3]',
        'NASA said the launch would move to a later window once the weather clears, and the agency did not give a new date in the reports cited here. [2]',
    ].join('\n\n') } });
    assert.strictEqual(r.status, 201, r.text);
    const story = r.json().story;
    r = await t.api(`/stories/${story.id}/publish`, { json: {} });
    assert.strictEqual(r.status, 200, r.text);

    await check('bodies are never stored: no column of News’ database holds the article text', async () => {
        const rows = t.db().prepare('SELECT * FROM news_source_items').all();
        assert.strictEqual(rows.length, 3);
        const dump = JSON.stringify(rows) + JSON.stringify(t.db().prepare('SELECT fields, content FROM news_story_revisions').all());
        for (const s of [BODY_SENTINEL, TAIL_SENTINEL, FORBIDDEN_SENTINEL, UNLICENSED_SENTINEL]) assert.ok(!dump.includes(s), `${s} was stored`);
        const a = rows.find((x) => x.sources_item_id === allowed.id);
        assert.ok(a.summary && a.summary.length <= 280, 'the allowed summary is kept, short');
        assert.strictEqual(a.summary_basis, 'terms_allow_short_summaries');
        assert.strictEqual(rows.find((x) => x.sources_item_id === forbidden.id).summary, null);
        assert.strictEqual(rows.find((x) => x.sources_item_id === forbidden.id).summary_basis, 'terms_forbid_summaries');
        assert.strictEqual(rows.find((x) => x.sources_item_id === unlicensed.id).summary_basis, 'terms_do_not_allow_summaries');
    });

    await check('no public surface, API response, event or Search document carries licensed text beyond the allowance', async () => {
        const paths = ['/', '/topics', '/topics/space', `/stories/${story.slug}`, `/stories/${story.slug}.json`, `/stories/${story.slug}?group=outlet`, `/stories/${story.slug}?group=perspective`,
            '/feed.xml', '/atom.xml', '/feed.json', '/topics/space/feed.xml', '/topics/space/atom.xml', '/topics/space/feed.json',
            '/sitemap.xml', '/sitemaps/stories.xml', '/sitemaps/topics.xml', '/robots.txt', '/llms.txt', '/api/v1/stories', `/api/v1/stories/${story.id}`, '/api/v1/topics'];
        let seen = '';
        for (const p of paths) {
            const res = await t.get(p);
            assert.strictEqual(res.status, 200, `${p} → ${res.status}`);
            seen += res.text;
        }
        seen += JSON.stringify(t.events());
        for (const s of [BODY_SENTINEL, TAIL_SENTINEL, FORBIDDEN_SENTINEL, UNLICENSED_SENTINEL, 'The full article text goes on']) assert.ok(!seen.includes(s), `${s} leaked`);
        const page = await t.get(`/stories/${story.slug}`);
        assert.match(page.text, /Storms delayed the Europa Clipper launch\./, 'the licensed short summary is shown in the source table');
        const feeds = (await t.get('/feed.xml')).text + (await t.get('/feed.json')).text;
        assert.ok(!feeds.includes('Storms delayed the Europa Clipper launch.'), 'feeds carry our text only, never a source summary');
        const doc = t.events('news.index_document.upserted').pop().payload;
        assert.ok(!JSON.stringify(doc).includes('Storms delayed the Europa Clipper launch.'), 'the Search document carries our text only');
    });

    await t.close();
    done();
})();
