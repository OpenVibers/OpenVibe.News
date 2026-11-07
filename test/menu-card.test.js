'use strict';
// The menu's network card for OpenVibe.News (frame.menu-card@1): GET /.well-known/openvibe-menu.json serves
// "Top stories" — the published stories first published today (UTC) — and "Latest stories", the newest published
// stories of any age, when nothing was published today. Each links to its page on openvibe.news. It validates
// against frame.menu-cards@1, never carries a retracted, draft, unpublished or private story, is CORS * and is
// cached for five minutes. The public listing is exercised on a real (PGlite) database too.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createMenuCard, cardFrom, cardFromBriefs, startOfDay, ago, plain, CARD_TTL_S } = require('../server/menu-card');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { createStories } = require('../server/domain/stories');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const item = (over = {}) => ({
    headline: 'A story readers can check', url: '/stories/a-story', outlets: ['Example News'],
    published_at: NOW - 2 * 60 * 60_000, retracted: false, ...over,
});

// ── Today's card: shape, words and contract ─────────────────────────────
const card = cardFrom([
    item(),
    item({ headline: '<b>Second</b>\nstory', url: '/stories/second', outlets: ['Other', 'Third'], published_at: NOW - 5 * 60 * 60_000 }),
    item({ headline: 'Yesterday', url: '/stories/yesterday', outlets: ['Old Wire'], published_at: NOW - 26 * 60 * 60_000 }),
], NOW);
const checked = contracts.validate('frame.menu-cards@1', [card]);
assert.ok(checked.valid, JSON.stringify(checked.errors));
assert.deepStrictEqual(Object.keys(card).sort(), ['id', 'items', 'kind', 'more', 'site', 'title', 'ttl_s', 'updated_at']);
assert.strictEqual(card.id, 'top-stories');
assert.strictEqual(card.site, 'news');
assert.strictEqual(card.title, 'Top stories');
assert.strictEqual(card.kind, 'rows');
assert.strictEqual(card.ttl_s, CARD_TTL_S);
assert.strictEqual(card.updated_at, new Date(NOW).toISOString());
assert.deepStrictEqual(card.items, [
    { title: 'A story readers can check', meta: 'Example News · 2h ago', url: 'https://openvibe.news/stories/a-story' },
    { title: 'Second story', meta: 'Other · 5h ago', url: 'https://openvibe.news/stories/second' },
]);
assert.deepStrictEqual(card.more, { label: 'All stories', url: 'https://openvibe.news/' });
assert.ok(card.title.length <= 60);
for (const it of card.items) assert.ok(it.title.length <= 80 && (!it.meta || it.meta.length <= 120) && it.url.startsWith('https://openvibe.news/'));

// Nothing today: the card falls back to the newest published stories of any age and says "Latest stories".
const latest = cardFrom([
    item({ headline: 'Yesterday', url: '/stories/yesterday', published_at: NOW - 26 * 60 * 60_000 }),
    item({ headline: 'Last week', url: '/stories/last-week', published_at: NOW - 8 * 24 * 60 * 60_000 }),
], NOW);
assert.strictEqual(latest.title, 'Latest stories');
assert.deepStrictEqual(latest.items.map((i) => i.title), ['Yesterday', 'Last week']);
assert.ok(contracts.validate('frame.menu-cards@1', [latest]).valid);
const empty = cardFrom([], NOW);
assert.deepStrictEqual(empty.items, []);
assert.strictEqual(empty.title, 'Latest stories');
assert.ok(contracts.validate('frame.menu-cards@1', [empty]).valid);

// Retracted and incomplete stories never enter the card, and at most five stories are sent.
assert.deepStrictEqual(cardFrom([item({ retracted: true })], NOW).items, []);
assert.deepStrictEqual(cardFrom([item({ headline: '  ' })], NOW).items, []);
assert.deepStrictEqual(cardFrom([item({ url: 'https://elsewhere.example/x' })], NOW).items, []);
assert.deepStrictEqual(cardFrom(null, NOW).items, []);
const many = Array.from({ length: 9 }, (_, i) => item({ headline: `Story ${i}`, url: `/stories/${i}` }));
assert.strictEqual(cardFrom(many, NOW).items.length, 5);

// Text is plain words and the meta line names the outlet and the time ago.
assert.strictEqual(plain('<img src=x onerror=alert(1)>Nova\n\t live ', 80), 'Nova live');
assert.strictEqual(plain('x'.repeat(200), 80).length, 80);
assert.strictEqual(ago(NOW - 30_000, NOW), 'just now');
assert.strictEqual(ago(NOW - 3 * 60 * 60_000, NOW), '3h ago');
assert.strictEqual(ago(null, NOW), '');
assert.strictEqual(startOfDay(NOW), Date.parse('2026-11-07T00:00:00Z'));

// ── No published story: the newest AI briefs, said to be AI briefs (11-07) ──
const brief = (o = {}) => ({ kind: 'summary', stub: false, paragraphs: [{ text: 'It says.' }], cluster_id: 'cl_1', headline: 'EU aid for climate projects', item_count: 3, window_end: NOW - 2 * 3600_000, ...o });
const fromBriefs = cardFromBriefs([brief(), brief({ cluster_id: 'cl_2', stub: true }), brief({ cluster_id: 'cl_3', paragraphs: [] }), brief({ cluster_id: 'cl_4', kind: 'event' }), brief({ cluster_id: 'bad id/x' })], NOW);
assert.strictEqual(fromBriefs.title, 'Latest AI briefs');
assert.deepStrictEqual(fromBriefs.items, [{ title: 'EU aid for climate projects', meta: 'AI brief · 3 reports · 2h ago', url: 'https://openvibe.news/briefs/cl_1' }], 'summaries with text only, each said to be an AI brief');
assert.deepStrictEqual(fromBriefs.more, { label: 'All AI briefs', url: 'https://openvibe.news/briefs' });
assert.ok(contracts.validate('frame.menu-cards@1', [fromBriefs]).valid);

// ── The five-minute cache and the route's headers ───────────────────────
(async () => {
    let t = 1_000;
    let loads = 0;
    const menu = createMenuCard({ load: async () => { loads++; return [item()]; }, now: () => t });
    const first = await menu.card();
    assert.strictEqual(loads, 1);
    assert.strictEqual(await menu.card(), first);
    assert.strictEqual(loads, 1, 'a second request inside the ttl is served from the cache');
    t += CARD_TTL_S * 1000 + 1;
    await menu.card();
    assert.strictEqual(loads, 2, 'after the ttl the card is rebuilt');

    const headers = {};
    let body = null;
    const res = {
        set(k, v) { headers[k] = v; return this; },
        json(v) { body = v; return this; },
    };
    await menu.handler({}, res);
    assert.strictEqual(headers['Access-Control-Allow-Origin'], '*');
    assert.strictEqual(headers['Cross-Origin-Resource-Policy'], 'cross-origin');
    assert.strictEqual(headers['Cache-Control'], 'public, max-age=60');
    assert.ok(Array.isArray(body) && body.length === 1, 'the file is an array of cards');
    assert.ok(contracts.validate('frame.menu-cards@1', body).valid);

    // A failing database keeps the last good card rather than publishing an empty list.
    let fail = false;
    const flaky = createMenuCard({ load: async () => { if (fail) throw new Error('db down'); return [item()]; }, now: () => t });
    const good = await flaky.card();
    fail = true;
    t += CARD_TTL_S * 1000 + 1;
    assert.strictEqual(await flaky.card(), good);

    // ── The public listing: published, public rows only, newest first ──
    const handle = await testDb();
    const db = handle.db;
    try {
        const store = createStore(db, { now: () => NOW });
        const stories = createStories({ store, config: { baseUrl: 'https://openvibe.news' }, publication: {}, clusters: {}, outbox: {} });
        const insert = db.prepare(`INSERT INTO news_stories
            (id, slug, working_headline, state, published_revision, first_published_at, published_at, created_by, created_at, updated_at, audience)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'usr_editor', ?, ?, ?)`);
        const row = (id, state, first, audience = 'public', revision = 1) =>
            insert.run(id, `story-${id}`, `Headline ${id}`, state, revision, first, first, NOW, NOW, audience);
        await row('sty_today', 'published', NOW - 60 * 60_000);
        await row('sty_retracted', 'retracted', NOW - 3 * 60 * 60_000);
        await row('sty_old', 'published', NOW - 26 * 60 * 60_000);
        await row('sty_draft', 'draft', null, 'private', null);
        await row('sty_unpublished', 'unpublished', null, 'public', null);
        await row('sty_private', 'published', NOW - 2 * 60 * 60_000, 'private');
        const { stories: rows } = await stories.listPublished({ limit: 20 });
        assert.deepStrictEqual(rows.map((r) => r.id), ['sty_today', 'sty_retracted', 'sty_old'],
            'drafts, unpublished and private stories never reach the public listing; retracted ones stay for the card to drop');
        const asItem = (r) => ({ headline: r.working_headline, url: `/stories/${r.slug}`, outlets: ['Wire'], published_at: r.first_published_at, retracted: r.state === 'retracted' });
        const served = cardFrom(rows.map(asItem), NOW);
        assert.strictEqual(served.title, 'Top stories');
        assert.deepStrictEqual(served.items.map((i) => i.title), ['Headline sty_today']);
        const fallback = cardFrom(rows.filter((r) => r.first_published_at < startOfDay(NOW)).map(asItem), NOW);
        assert.strictEqual(fallback.title, 'Latest stories');
        assert.deepStrictEqual(fallback.items.map((i) => i.title), ['Headline sty_old']);
    } finally {
        await handle.close();
    }

    // With no story the route falls back to the briefs; a story, when there is one, still wins.
    const viaBriefs = createMenuCard({ load: async () => [], loadBriefs: async () => [brief()], now: () => NOW });
    assert.strictEqual((await viaBriefs.card()).title, 'Latest AI briefs');
    const storyWins = createMenuCard({ load: async () => [item()], loadBriefs: async () => [brief()], now: () => NOW });
    assert.notStrictEqual((await storyWins.card()).title, 'Latest AI briefs');
    console.log('menu card: top/latest, contract, public listing, retracted filter, plain text, 5 min cache, CORS last-good card, and AI briefs when no story is published');
})().catch((err) => { console.error(err); process.exit(1); });
