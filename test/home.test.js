'use strict';
/**
 * The front page (/ page 1): its own description and one h1, the numbers (reports today and this week, outlets of
 * the last 30 days), the wire, every topic with what was reported on it, the outlets News reads with their newest
 * report, the questions shown and given as FAQPage (the outlets answer names today's outlets), WebSite + the topics'
 * ItemList, and the links around the site. The new sources' reports are placed in their topics.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');
const { topicsFor } = require('../server/domain/topic-match');
const { createHome } = require('../server/domain/home');

const ld = (text) => [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

(async () => {
    const t = await boot();
    launchReports(t.sources);
    t.sources.addSource('nist-news', { name: 'NIST news' });
    t.sources.addItem({ source_key: 'nist-news', title: 'New chip-based tape measure for light', url: 'https://www.nist.gov/news-events/news/2026/09/tape-measure', published_at: '2026-09-22T08:00:00Z' });
    await t.pull();
    try {
        let home;
        await check('the front page: its own description, one h1, the numbers', async () => {
            home = await t.get('/');
            assert.strictEqual(home.status, 200);
            assert.match(home.text, /<title>OpenVibe\.News: source-backed news, every claim cited<\/title>/);
            const desc = /<meta name="description" content="([^"]*)"/.exec(home.text)[1];
            assert.ok(desc.length <= 160 && /every paragraph links the reports/.test(desc), desc);
            assert.strictEqual((home.text.match(/<h1\b/g) || []).length, 1);
            const stats = await createHome({ store: t.ctx.store }).stats();
            assert.deepStrictEqual({ day: stats.day, week: stats.week, outlets: stats.outlets, stories: stats.stories }, { day: 4, week: 4, outlets: 4, stories: 0 });
            assert.match(home.text, /<dt>Reports this week<\/dt><dd>4<\/dd>/);
            assert.ok(!home.text.includes('<dt>Stories published</dt>'), 'no story yet: no stories tile');
        });

        await check('the wire, the topics with what was reported on them, the outlets with their newest report', async () => {
            const text = home.text;
            assert.ok(text.includes('From the wire') && text.includes('Europa Clipper'));
            const space = (/<li><h3><a href="\/topics\/space">Space<\/a><\/h3>[\s\S]*?<\/li>/.exec(text) || [''])[0];
            assert.match(space, /1 subject, 3 reports/);
            const science = (/<li><h3><a href="\/topics\/science">Science<\/a><\/h3>[\s\S]*?<\/li>/.exec(text) || [''])[0];
            assert.ok(science.includes('New chip-based tape measure for light'), 'NIST places its reports in Science');
            assert.ok(text.includes('<b>NIST news</b>') && text.includes('<b>Wire A</b>'));
            assert.match(text, /<b>Wire A<\/b><span class="nh-count">1 report this week · 1 in 30 days<\/span>/);
        });

        await check('questions, links and structured data', async () => {
            const text = home.text;
            const blocks = ld(text);
            assert.ok(blocks.find((b) => b['@type'] === 'WebSite'));
            const topics = blocks.find((b) => b['@type'] === 'ItemList');
            assert.ok(topics.itemListElement.some((x) => /\/topics\/space$/.test(x.url)));
            const faq = blocks.find((b) => b['@type'] === 'FAQPage');
            for (const q of faq.mainEntity) assert.ok(text.includes(`<summary>${q.name}</summary>`), q.name);
            assert.ok(faq.mainEntity.find((q) => q.name === 'Where do the reports come from?').acceptedAnswer.text.includes('NIST news'));
            ['/live', '/briefs', '/wire', '/topics', '/feed.xml', '/updates'].forEach((p) => assert.ok(text.includes(`href="${p}"`), p));
        });

        await check('the new sources place their reports in their topics', async () => {
            assert.deepStrictEqual(topicsFor({ label: 'tape measure', headlines: [], sources: ['nist-news'] }), ['science']);
            assert.deepStrictEqual(topicsFor({ label: 'newsroom', headlines: [], sources: ['cdc-newsroom'] }), ['health']);
            assert.deepStrictEqual(topicsFor({ label: 'enforcement action', headlines: [], sources: ['federal-reserve-press'] }), ['business']);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
