'use strict';
/**
 * The wire (GET /wire, and "From the wire" on the front page): what the sources report, grouped by cluster, with each
 * outlet's own headline and link, labelled as not written by News. A report removed upstream leaves it; a javascript:
 * link never becomes one; the page is not indexed but its links are followed; the front page still says no story is
 * published, and points at the wire.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const reports = launchReports(t.sources);
    const [A, B, C] = ['https://wire-a.example/space/europa-clipper-launch', 'https://paper-b.example/2026/09/22/europa-clipper', 'https://site-c.example/europa-clipper-why'];
    t.sources.addSource('odd', { name: 'Odd' });
    t.sources.addItem({ source_key: 'odd', title: 'A link that is not a web address', url: 'javascript:alert(1)', published_at: '2026-09-22T11:00:00Z' });
    t.sources.addItem({ source_key: 'site-c', title: 'Local bakery wins regional sourdough prize', url: 'https://site-c.example/bakery', published_at: '2026-09-22T10:40:00Z' });
    await t.pull();

    try {
        await check('the wire lists every cluster with the outlets’ own headlines and links, labelled, not indexed', async () => {
            const r = await t.get('/wire');
            assert.strictEqual(r.status, 200);
            [A, B, C].forEach((u) => assert.ok(r.text.includes(u), u));
            assert.ok(r.text.includes('Local bakery wins regional sourdough prize'));
            assert.ok(r.text.includes('Nothing here is written by OpenVibe.News'));
            assert.ok(!r.text.includes('href="javascript:'), 'never a javascript: link');
            assert.match(r.headers.get('x-robots-tag') || '', /noindex, follow/);
            assert.match(r.headers.get('cache-control') || '', /public/);
        });

        await check('the front page shows the latest clusters from the wire, and no "no stories yet" apology', async () => {
            const r = await t.get('/');
            assert.ok(!r.text.includes('No stories have been published yet'));
            assert.ok(r.text.includes('From the wire') && r.text.includes('href="/wire"'));
            assert.ok(r.text.includes('Europa Clipper'));
            assert.ok(!/noindex/.test(r.headers.get('x-robots-tag') || ''), 'with the wire, the front page is not empty: it is indexed');
        });

        await check('a report removed upstream leaves the wire', async () => {
            t.sources.removeItem(reports.b.id, 'licence review');
            await t.pull();
            const r = await t.get('/wire');
            assert.ok(!r.text.includes(B));
            assert.ok(r.text.includes(A));
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
