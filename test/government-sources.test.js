'use strict';
/**
 * The three US government feeds News reads through OpenVibe.Sources (sec-press, doj-news, dol-news): each item is
 * attributed to the agency it comes from, links back to the agency, and keeps the headline and a short excerpt only —
 * never the release's full text (a recorded fixture: no live call here).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const BODY = 'SECRET-GOVERNMENT-FULL-TEXT-51a2';

(async () => {
    const t = await boot();
    try {
        await check('an item of each government feed is attributed to its agency and links back to it', async () => {
            t.sources.addSource('sec-press', {});
            t.sources.addSource('doj-news', {});
            t.sources.addSource('dol-news', {});
            const sec = t.sources.addItem({
                source_key: 'sec-press', title: 'SEC charges two brokers over misleading investor statements',
                url: 'https://www.sec.gov/news/pressreleases/2026-88', summary: 'The Securities and Exchange Commission charged two brokers over misleading investor statements.',
                terms_note: 'Keep the headline and a short summary of each release, never the whole release, and link back to the release on sec.gov.',
                fields: { body: BODY }, published_at: '2026-10-30T12:00:00Z', authors: [],
            });
            const doj = t.sources.addItem({
                source_key: 'doj-news', title: 'Justice Department reaches settlement in healthcare fraud case',
                url: 'https://www.justice.gov/news/press-releases/2026/10/settlement', summary: 'The Department of Justice announced a settlement in a healthcare fraud case today.',
                terms_note: 'Keep the headline and a short summary of each item, never the whole text, and link back to the justice.gov page.',
                fields: { body: BODY }, published_at: '2026-10-30T13:00:00Z', authors: [],
            });
            const dol = t.sources.addItem({
                source_key: 'dol-news', title: 'Department of Labor publishes new rule on worker classification',
                url: 'https://www.dol.gov/newsroom/releases/osec/2026-31', summary: 'The Department of Labor published a rule on worker classification today.',
                terms_note: 'Keep the headline and a short summary of each release, never the whole text, and link back to dol.gov.',
                fields: { body: BODY }, published_at: '2026-10-30T14:00:00Z', authors: [],
            });
            await t.pull();
            const rows = await t.db().many('SELECT source_key, headline, outlet, canonical_url, summary FROM news_source_items WHERE source_key IN (\'sec-press\',\'doj-news\',\'dol-news\') ORDER BY source_key');
            assert.deepStrictEqual(rows.map((r) => [r.source_key, r.outlet, r.canonical_url]), [
                ['doj-news', 'US Department of Justice', 'https://www.justice.gov/news/press-releases/2026/10/settlement'],
                ['dol-news', 'US Department of Labor', 'https://www.dol.gov/newsroom/releases/osec/2026-31'],
                ['sec-press', 'US Securities and Exchange Commission', 'https://www.sec.gov/news/pressreleases/2026-88'],
            ]);
            for (const r of rows) {
                assert.ok(r.headline && r.headline.length > 10, 'the headline is kept');
                assert.ok(r.summary && r.summary.length > 10, 'a short excerpt is kept');
                assert.ok(!r.summary.includes(BODY), 'the full text is not kept, only the excerpt the notes allow');
            }
            const all = await t.db().many('SELECT * FROM news_source_items');
            assert.ok(!JSON.stringify(all).includes(BODY), 'the release text never reaches the database');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
