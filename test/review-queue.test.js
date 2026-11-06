'use strict';
/**
 * The reviewer queue for AI briefs: editor-only listing, the review action, and the gate effect —
 * a brief page is indexable while a person's approval matches the exact text, and a remake after
 * the cluster changes puts it back in the queue and back to noindex.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

const run = (output, id = 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7E1') => ({ status: 201, run: { id, status: 'succeeded', workflow: { key: 'news.summarize_story', version: 3 }, synthetic: false, provenance: { model: 'test-model' }, output } });

(async () => {
    const t = await boot({ ai: true });
    const person = t.network.addUser('person');
    try {
        launchReports(t.sources);
        await t.pull();
        const clusterId = (await t.db().prepare("SELECT cluster_id, count(*) AS n FROM news_source_items WHERE status = 'active' GROUP BY cluster_id ORDER BY n DESC").get()).cluster_id;
        t.ai.setNext(run({ headline: 'Europa Clipper is on its way', summary: 'NASA launched Europa Clipper toward Jupiter.', key_points: [{ text: 'It reaches Jupiter in 2030.', citations: [1] }], timeline: [], citations: [0, 1], gaps: [] }));
        await t.ctx.briefs.sweep();

        await check('the queue lists the AI brief, editor-only, with a review path', async () => {
            const r = await t.api('/review-queue');
            assert.strictEqual(r.status, 200, r.text);
            const item = r.json().items.find((i) => i.id === clusterId);
            assert.ok(item, 'the unreviewed brief is waiting');
            assert.deepStrictEqual([item.site, item.kind], ['news', 'ai_brief']);
            assert.strictEqual(item.review.path, `/api/v1/briefs/${clusterId}/reviews`);
            assert.strictEqual(item.url, `/briefs/${clusterId}`);
            assert.ok(item.reasons.some((x) => x.code === 'ai_generated_unreviewed' && /AI-written/.test(x.text)));
            const no = await t.get('/api/v1/review-queue', { as: person });
            assert.strictEqual(no.status, 403);
            assert.strictEqual(no.json().code, 'news.editor_required');
        });

        await check('an approval through the service review makes the brief page indexable and lists it in the briefs sitemap', async () => {
            const before = await t.get(`/briefs/${clusterId}`);
            assert.ok(before.text.includes('noindex'));
            const r = await t.api(`/briefs/${clusterId}/reviews`, { json: { kind: 'summary', tone: 'neutral', decision: 'approved', note: 'Checked against the reports' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().review.reviewer, t.editor.subject);
            const page = await t.get(`/briefs/${clusterId}`);
            assert.ok(page.text.includes('<meta name="robots" content="index, follow">'), 'reviewed: indexable');
            assert.ok(page.text.includes('Reviewed by a person'), 'the page says who reviewed it');
            const sitemap = await t.get('/sitemaps/briefs.xml');
            assert.ok(sitemap.text.includes(`/briefs/${clusterId}`), 'a reviewed brief is in the sitemap');
            const q = await t.api('/review-queue');
            assert.ok(!q.json().items.some((i) => i.id === clusterId), 'a reviewed brief leaves the queue');
            const audit = await t.db().prepare('SELECT * FROM news_brief_reviews WHERE cluster_id = ?').all(clusterId);
            assert.strictEqual(audit.length, 1, 'the review log is the audit');
        });

        await check('a reject keeps it hidden and out of the queue; a remake waits for a person again', async () => {
            t.clock.advance(60 * 60 * 1000);
            t.ai.setNext(run({ headline: 'Europa Clipper, remade', summary: 'The same reports, written again.', key_points: [], timeline: [], citations: [0], gaps: [] }, 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7E2'));
            await t.ctx.briefs.make(clusterId, { kind: 'summary', tone: 'neutral' });
            const q = await t.api('/review-queue');
            const item = q.json().items.find((i) => i.id === clusterId);
            assert.ok(item, 'a remake after its review is waiting again');
            const r = await t.api(`/briefs/${clusterId}/reviews`, { json: { kind: 'summary', tone: 'neutral', decision: 'rejected', note: 'Not accurate' } });
            assert.strictEqual(r.status, 201, r.text);
            const page = await t.get(`/briefs/${clusterId}`);
            assert.ok(page.text.includes('noindex'), 'rejected: still noindex');
            const after = await t.api('/review-queue');
            assert.ok(!after.json().items.some((i) => i.id === clusterId), 'the rejection clears the queue for this text');
        });
    } finally {
        await t.close();
        done();
    }
})().catch((e) => { console.error(e); process.exit(1); });
