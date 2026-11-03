'use strict';
/**
 * The home on a phone (the owner, 2026-10-31: never hide content to shorten a page): the home's lists are rails you
 * swipe, every item shown, and the parts a reader rarely needs are folds. They used to be one item at a time behind a
 * row of radio chips, the rest display:none.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

(async () => {
    const t = await boot();
    launchReports(t.sources);
    await t.pull();
    try {
        await check('the wire is a rail on a phone: every cluster shown, no chips, nothing hidden', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const block = page.slice(page.indexOf('<div class="pick pick--rail" id="pick-wire">'), page.indexOf('<div class="pick pick--rail" id="pick-topics">'));
            assert.ok(block.startsWith('<div class="pick pick--rail" id="pick-wire">'), 'the wire rail is on the home');
            assert.ok(!/type="radio"|pick-row/.test(block), 'no radio chips');
            const clusters = [...block.matchAll(/<li class="wire-cluster" id="wire-[^"]+"/g)];
            assert.ok(clusters.length >= 1, `every cluster is in the page (${clusters.length})`);
        });

        await check('the topics are a rail too: every topic in the page, no chips', async () => {
            const r = await t.get('/');
            const page = r.text;
            const at = page.indexOf('<div class="pick pick--rail" id="pick-topics">');
            assert.ok(at > 0, 'the topics rail is on the home');
            const block = page.slice(at, at + 4000);
            assert.ok(!/type="radio"/.test(block), 'no radio chips');
            const items = [...block.matchAll(/<li data-i=(?:"|&quot;)?(\d+)"?><h3><a href="\/topics\/[a-z-]+">/g)];
            assert.ok(items.length >= 3, `every topic stays in the page (${items.length})`);
        });

        await check('the CSS: on a phone a list is a rail you swipe, and no rule hides an item (the owner, 2026-10-31)', async () => {
            const r = await t.get('/');
            assert.ok(!/\.pick:has\(#pk-/.test(r.text), 'no per-item rule in the page');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'news.css'), 'utf8');
            assert.match(css, /\.pick--rail \.pick-list \{ display: flex;[^}]*overflow-x: auto;[^}]*scroll-snap-type: x mandatory/, 'the list is a rail');
            assert.match(css, /\.pick--rail \.pick-list > li \{ flex: 0 0 84%/, 'the next item peeks in');
            assert.ok(!/pick-list > li \{ display: none/.test(css), 'no item is hidden');
            assert.ok(!/li:nth-child\(n\+\d+\) \{ display: none/.test(css), 'nothing is cut after the third or sixth');
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
