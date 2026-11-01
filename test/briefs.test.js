'use strict';
/**
 * AI briefs and the live view (server/domain/briefs.js, render/briefs.js; the owner's April ask: multi-source summaries
 * with tone and perspective controls, and a breaking-news live updater). The sweep summarizes a cluster with two or
 * more reports; every paragraph cites its reports and uncited claims are dropped; the page labels it as AI, is never
 * indexed, and shows the reports; a reader's POST asks for another tone or the outlets' comparison (same-origin only);
 * a stub provider's output is never shown; a changed cluster's brief is stale and made again; /live refreshes itself
 * and marks what is breaking. Below two independent outlets nothing is summarized: the page lists the reports and says why.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

const run = (output, id = 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7E1', synthetic = false) => ({ status: 201, run: { id, status: 'succeeded', workflow: { key: 'news.summarize_story', version: 3 }, synthetic, provenance: { model: 'test-model' }, output } });
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot({ ai: true });
    try {
        launchReports(t.sources);
        await t.pull();
        const clusterId = (await t.db().prepare("SELECT cluster_id, count(*) AS n FROM news_source_items WHERE status = 'active' GROUP BY cluster_id ORDER BY n DESC").get()).cluster_id;

        await check('the sweep writes a cited summary for a cluster with two or more reports; uncited claims are dropped', async () => {
            t.ai.setNext(run({ headline: 'Europa Clipper is on its way', summary: 'NASA launched Europa Clipper toward Jupiter.', key_points: [{ text: 'It reaches Jupiter in 2030.', citations: [1] }, { text: 'A claim nobody reported.', citations: [] }], timeline: [], citations: [0, 1], gaps: [] }));
            const made = await t.ctx.briefs.sweep();
            assert.strictEqual(made, 1);
            const sent = t.ai.requests.pop();
            assert.strictEqual(sent.workflow, 'news.summarize_story');
            assert.strictEqual(sent.input.tone, 'neutral');
            const got = await t.ctx.briefs.get(clusterId);
            assert.ok(got.fresh);
            assert.deepStrictEqual(got.brief.paragraphs.map((p) => p.text), ['NASA launched Europa Clipper toward Jupiter.', 'It reaches Jupiter in 2030.']);
            assert.ok(got.brief.gaps.some((g) => /uncited/.test(g)));
            assert.strictEqual(await t.ctx.briefs.sweep(), 0, 'a fresh brief is not made again');
        });

        await check('/briefs/:id: labelled AI, cited to the reports below it, never indexed; listed on /briefs', async () => {
            const r = await t.get(`/briefs/${clusterId}`);
            assert.strictEqual(r.status, 200, r.text.slice(0, 200));
            assert.ok(r.text.includes('AI brief') && r.text.includes('Written by OpenVibe.AI'));
            assert.ok(r.text.includes('Europa Clipper is on its way'));
            assert.match(r.text, /href="#source-2"/);
            assert.ok(r.text.includes('id="source-1"'), 'the reports are in the page');
            assert.ok(r.text.includes('noindex'));
            assert.ok(!r.text.includes('A claim nobody reported') || r.text.includes('What the AI left out'));
            const list = await t.get('/briefs');
            assert.ok(list.text.includes(`/briefs/${clusterId}`));
            const home = await t.get('/');
            // With no editor's story, the briefs lead the front page: "Latest AI briefs", each labelled AI.
            assert.ok(home.text.includes('>Latest AI briefs</h2>') && home.text.includes(`href="/briefs/${clusterId}"`), 'the front page leads with the latest briefs');
            assert.ok(home.text.includes('Not written or reviewed by an editor') && home.text.includes('<span class="badge badge-ai">AI brief</span>'));
            assert.ok(!home.text.includes('No stories have been published yet'));
        });

        await check('a reader asks for another tone with a POST from this site; a GET never runs AI', async () => {
            const before = t.ai.requests.length;
            const page = await t.get(`/briefs/${clusterId}?tone=brief`);
            assert.ok(page.text.includes('Write it with AI'));
            assert.strictEqual(t.ai.requests.length, before, 'reading never runs AI');
            assert.strictEqual((await t.get(`/briefs/${clusterId}/make`, { method: 'POST', form: { kind: 'summary', tone: 'brief' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
            t.ai.setNext(run({ headline: 'Europa Clipper launched', summary: 'NASA sent Europa Clipper to Jupiter.', key_points: [], timeline: [], citations: [0], gaps: [] }, 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7E2'));
            const made = await t.get(`/briefs/${clusterId}/make`, { method: 'POST', form: { kind: 'summary', tone: 'brief' }, headers: SAME });
            assert.strictEqual(made.status, 303);
            assert.strictEqual(t.ai.requests.pop().input.tone, 'brief');
            assert.ok((await t.get(`/briefs/${clusterId}?tone=brief`)).text.includes('NASA sent Europa Clipper to Jupiter.'));
        });

        await check('how the outlets put it: compare_perspectives on request, cited', async () => {
            t.ai.setNext(run({ question: 'How was the launch covered?', perspectives: [{ label: 'Wire A', summary: 'Focus on the rocket.', citations: [0] }, { label: 'Paper B', summary: 'Focus on the science.', citations: [1] }], agreements: [], disagreements: [], citations: [0, 1], gaps: [] }, 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7E3'));
            const made = await t.get(`/briefs/${clusterId}/make`, { method: 'POST', form: { kind: 'perspectives', tone: 'neutral' }, headers: SAME });
            assert.strictEqual(made.status, 303);
            assert.strictEqual(t.ai.requests.pop().workflow, 'news.compare_perspectives');
            assert.ok((await t.get(`/briefs/${clusterId}`)).text.includes('Paper B: Focus on the science.'));
        });

        await check('stub output is never shown; a failed run makes nothing and says so', async () => {
            t.ai.setNext(run({ headline: 'STUB', summary: 'stub text', key_points: [], timeline: [], citations: [0], gaps: [] }, 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7E4', true));
            await t.get(`/briefs/${clusterId}/make`, { method: 'POST', form: { kind: 'summary', tone: 'explained' }, headers: SAME });
            assert.ok(!(await t.get(`/briefs/${clusterId}?tone=explained`)).text.includes('stub text'));
            t.ai.setNext(null);
            const failed = await t.get(`/briefs/${clusterId}/make`, { method: 'POST', form: { kind: 'summary', tone: 'explained' }, headers: SAME });
            assert.match(failed.headers.get('location'), /failed=/);
        });

        await check('/live refreshes itself and links the AI briefs; it is not indexed', async () => {
            const r = await t.get('/live');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('refresh'), '60');
            assert.ok(r.text.includes(`/briefs/${clusterId}`) && r.text.includes('noindex'));
            const home = await t.get('/');
            assert.ok(home.text.includes('href="/live"') && home.text.includes('href="/briefs"'), 'in the navigation');
        });
        await check('one outlet is not enough: no summary is written, made or shown; the reports are, with why (market outcome 4)', async () => {
            // The same story, now reported by one outlet only.
            await t.db().prepare("UPDATE news_source_items SET outlet = 'GOV.UK' WHERE cluster_id = ?").run(clusterId);
            const got = await t.ctx.briefs.get(clusterId);
            assert.deepStrictEqual([got.outlets, got.enough, got.minOutlets], [1, false, 2]);
            const r = await t.get(`/briefs/${clusterId}`);
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<span class="badge badge-reports">Reports<\/span> \d+ reports by 1 outlet: GOV\.UK/);
            assert.match(r.text, /No AI summary: only one outlet has reported this, and we write one only once 2 independent outlets have\./);
            assert.ok(!r.text.includes('Europa Clipper is on its way') && !r.text.includes('Written by OpenVibe.AI'), 'the stored summary is not shown');
            assert.ok(r.text.includes('id="source-1"'), 'the reports are');
            assert.ok(!r.text.includes('Write it with AI'), 'and nobody is offered to make one');
            assert.ok(!(await t.get('/briefs')).text.includes(`/briefs/${clusterId}`), 'not listed among the briefs');
            const before = t.ai.requests.length;
            await assert.rejects(() => t.ctx.briefs.make(clusterId, { kind: 'summary', tone: 'brief' }), (e) => e.code === 'brief.too_few_outlets' && e.status === 422);
            await t.db().prepare('UPDATE news_story_clusters SET updated_at = updated_at + 1 WHERE id = ?').run(clusterId);
            assert.strictEqual(await t.ctx.briefs.sweep(), 0, 'the sweep does not ask AI about it');
            assert.strictEqual(t.ai.requests.length, before, 'AI was never asked');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
