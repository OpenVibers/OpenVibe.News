'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the home's lists of the same kind are one pick
 * block, a row of chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(),
 * no script for the chips; every list stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

(async () => {
    const t = await boot();
    launchReports(t.sources);
    await t.pull();
    try {
        await check('the home is one pick block: a chip per item, the first picked, every item in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const block = page.slice(page.indexOf('<div class="pick" id="pick-wire">'), page.indexOf('<div class="pick" id="pick-topics">'));
            assert.ok(block.startsWith('<div class="pick" id="pick-wire">'), 'the pick block is on the home');
            assert.match(block, /<div class="pick-row" role="radiogroup" aria-label="From the wire">/);
            const chips = [...block.matchAll(/<input type="radio" name="pick-wire" id="pk-wire-(\d+)" value="\1"( checked)?><label for="pk-wire-\1">([^<]+)<\/label>/g)];
            assert.ok(chips.length >= 1, `a chip per item (${chips.length})`);
            assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), [chips[0][1]], 'the first item is picked');
            // Every cluster stays in the page, with the index its chip picks.
            const clusters = [...block.matchAll(/<li class="wire-cluster" id="wire-[^"]+" data-i=(?:"|&quot;)?(\d+)/g)];
            assert.strictEqual(clusters.length, chips.length, 'every cluster is in the page');
            assert.deepStrictEqual(clusters.map((m) => m[1]), chips.map((m) => m[1]), 'each cluster knows its chip');
        });

        await check('the topics are a pick block too: a chip per topic, every topic in the page', async () => {
            const r = await t.get('/');
            const page = r.text;
            const block = page.slice(page.indexOf('<div class="pick" id="pick-topics">'), page.indexOf('<div class="pick" id="pick-topics">') + 4000);
            const chips = [...block.matchAll(/<input type="radio" name="pick-topics" id="pk-topics-(\d+)" value="\1"( checked)?><label for="pk-topics-\1">([^<]+)<\/label>/g)];
            assert.ok(chips.length >= 3, `a chip per topic (${chips.length})`);
            assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), [chips[0][1]], 'the first topic is picked');
            const items = [...block.matchAll(/<li data-i=(?:"|&quot;)?(\d+)"?><h3><a href="\/topics\/[a-z-]+">/g)];
            assert.strictEqual(items.length, chips.length, 'every topic stays in the page');
        });

        await check('the CSS guard: the chips are hidden and the items all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.match(page, /<style>@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{\.pick:has\(#pk-wire-0:checked\) \.pick-list>li\[data-i="0"\]\{display:block\}/, 'the rule that shows the picked item');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'news.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
            assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
            assert.match(css, /\.pick \.pick-list > li \{ display: none; \}/, 'the items are hidden on a phone');
        });

        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['outlets', 'faq']) {
                assert.ok(page.includes(`<details class="nh-fold nh-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(page.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
            }
            // The content of the folds stays in the page.
            assert.match(page, /<h2 id="nh-outlets-h">The sources we read<\/h2>/);
            assert.match(page, /<h2 id="nh-faq-h">Questions<\/h2>/);
        });
    } finally {
        await done(t);
    }
})().catch((e) => { console.error(e); process.exit(1); });
