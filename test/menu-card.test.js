'use strict';
// The menu's network card for OpenVibe.News (frame.menu-card@1): GET /.well-known/openvibe-menu.json serves the
// "Top stories" array — the newest published stories, each linking to its page on openvibe.news. It validates
// against frame.menu-cards@1, never carries a retracted story, is CORS * and is cached for five minutes.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createMenuCard, cardFrom, ago, plain, CARD_TTL_S } = require('../server/menu-card');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const item = (over = {}) => ({
    headline: 'A story readers can check', url: '/stories/a-story', outlets: ['Example News'],
    published_at: NOW - 2 * 60 * 60_000, retracted: false, ...over,
});

// ── The card's shape and words ───────────────────────────────────────────
const card = cardFrom([
    item(),
    item({ headline: '<b>Second</b>\nstory', url: '/stories/second', outlets: ['Other', 'Third'], published_at: NOW - 26 * 60 * 60_000 }),
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
    { title: 'Second story', meta: 'Other · 1d ago', url: 'https://openvibe.news/stories/second' },
]);
assert.deepStrictEqual(card.more, { label: 'All stories', url: 'https://openvibe.news/' });
assert.ok(card.title.length <= 60);
for (const it of card.items) assert.ok(it.title.length <= 80 && (!it.meta || it.meta.length <= 120) && it.url.startsWith('https://openvibe.news/'));

// Retracted and incomplete stories never enter the card, and at most six stories are sent.
assert.deepStrictEqual(cardFrom([item({ retracted: true })], NOW).items, []);
assert.deepStrictEqual(cardFrom([item({ headline: '  ' })], NOW).items, []);
assert.deepStrictEqual(cardFrom([item({ url: 'https://elsewhere.example/x' })], NOW).items, []);
assert.deepStrictEqual(cardFrom(null, NOW).items, []);
const many = Array.from({ length: 9 }, (_, i) => item({ headline: `Story ${i}`, url: `/stories/${i}` }));
assert.strictEqual(cardFrom(many, NOW).items.length, 6);

// Text is plain words and the meta line names the outlet and the time ago.
assert.strictEqual(plain('<img src=x onerror=alert(1)>Nova\n\t live ', 80), 'Nova live');
assert.strictEqual(plain('x'.repeat(200), 80).length, 80);
assert.strictEqual(ago(NOW - 30_000, NOW), 'just now');
assert.strictEqual(ago(NOW - 3 * 60 * 60_000, NOW), '3h ago');
assert.strictEqual(ago(null, NOW), '');

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

    console.log('menu card: shape, contract, retracted filter, plain text, 5 min cache, CORS and last-good card');
})().catch((err) => { console.error(err); process.exit(1); });
