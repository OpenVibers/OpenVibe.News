'use strict';
/**
 * The AI editor (plan 2026-10-22 §"The editorial queue"): a second reviewer kind, `ai_editor`,
 * recorded on a story's review and on an AI brief's review by the orchestrator's service principal.
 * Its approval publishes and indexes the text exactly as a person's does, but the page says
 * "Checked by OpenVibe's AI editor" (with the date) — never "Reviewed by a person". A person's
 * review path and label do not change, and a page can show both.
 *
 * Only a service token whose principal holds news.review.ai_editor may record one; a token without
 * it is refused and writes nothing.
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

const AI_ON_PAGE = /Checked by OpenVibe(?:&#39;|')s AI editor/;
const wf = { id: 'news.summarize_story', runId: 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7D8', version: 1 };

async function storyPart() {
    const t = await boot({ ai: true });
    try {
        const reports = launchReports(t.sources, { a: { fields: { body: 'AI editor story source' } } });
        await t.pull();
        const clusterId = (await t.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id)).cluster_id;
        const story = (await t.api('/stories', { json: { cluster: clusterId, headline: 'Europa Clipper launch', topic: 'space' } })).json().story;
        const aiToken = t.network.serviceToken('ai', ['news.story.revise']);
        const editor = t.network.signService({ sub: 'svc:orchestrator', aud: ['openvibe.news'], cap: ['news.review.ai_editor'] });
        const paragraphs = [
            { text: 'NASA launched the Europa Clipper spacecraft on a Falcon Heavy rocket from Kennedy Space Center, beginning a cruise of several years to Jupiter and its moon Europa.', sources: [reports.a.id, reports.b.id] },
            { text: 'According to NASA the spacecraft should arrive at Jupiter in 2030, after which it will make repeated close passes of Europa to study its ice shell and the ocean beneath.', sources: [reports.b.id] },
        ];
        const rev = (await t.get(`/api/v1/stories/${story.id}/revisions`, { as: aiToken, headers: { 'x-ov-origin': 'ai' }, json: { headline: 'Europa Clipper is on its way to Jupiter', paragraphs, expected_revision: 0, authorship: { workflow: wf } } })).json().revision;

        await check('a token without news.review.ai_editor is refused and writes nothing', async () => {
            const r = await t.get(`/api/v1/stories/${story.id}/reviews`, { as: aiToken, json: { revision: rev, decision: 'approved' } });
            assert.strictEqual(r.status, 403, r.text);
            assert.strictEqual(r.json().code, 'capability.denied');
            assert.strictEqual((await t.ctx.store.reviews.history(story.id)).length, 0);
        });

        await check('the AI editor approves: the story publishes and reads "Checked by OpenVibe\'s AI editor"', async () => {
            const r = await t.get(`/api/v1/stories/${story.id}/reviews`, { as: editor, json: { revision: rev, decision: 'approved', note: 'Checked every claim' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.deepStrictEqual([r.json().review.reviewerKind, r.json().review.reviewer, r.json().review.decision], ['ai_editor', 'svc:orchestrator', 'approved']);
            const pub = await t.api(`/stories/${story.id}/publish`, { json: { revision: rev } });
            assert.strictEqual(pub.status, 200, pub.text);
            const page = await t.get(`/stories/${story.slug}`);
            assert.ok(page.text.includes('<meta name="robots" content="index, follow">'), 'indexable');
            assert.ok(AI_ON_PAGE.test(page.text), 'the page says who checked it');
            assert.ok(!/reviewed by a person/i.test(page.text), 'never as a person\'s review');
            const json = (await t.get(`/stories/${story.slug}.json`)).json();
            assert.strictEqual(json.authorship.reviewed, true);
            assert.ok(json.authorship.labels.some((l) => l.startsWith("Checked by OpenVibe's AI editor")), JSON.stringify(json.authorship));
            assert.deepStrictEqual([json.authorship.reviews.ai_editor.decision, json.authorship.reviews.person], ['approved', null]);
        });

        await check('a person\'s review still says "Reviewed by a person"; both can show', async () => {
            const r = await t.api(`/stories/${story.id}/reviews`, { json: { revision: rev, decision: 'approved' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().review.reviewerKind, 'person');
            const page = await t.get(`/stories/${story.slug}`);
            assert.ok(/reviewed by a person/i.test(page.text), 'the person\'s label is unchanged');
            assert.ok(AI_ON_PAGE.test(page.text), 'and both are shown');
        });
    } finally {
        await t.close();
    }
}

async function briefPart() {
    const t = await boot({ ai: true });
    try {
        const run = (id) => ({ status: 201, run: { id, status: 'succeeded', workflow: { key: 'news.summarize_story', version: 3 }, synthetic: false, provenance: { model: 'test-model' }, output: { headline: 'Europa Clipper is on its way', summary: 'NASA launched Europa Clipper toward Jupiter.', key_points: [{ text: 'It reaches Jupiter in 2030.', citations: [1] }], timeline: [], citations: [0, 1], gaps: [] } } });
        launchReports(t.sources);
        await t.pull();
        const clusterId = (await t.db().prepare("SELECT cluster_id, count(*) AS n FROM news_source_items WHERE status = 'active' GROUP BY cluster_id ORDER BY n DESC").get()).cluster_id;
        t.ai.setNext(run('run_01J8Z3V9Q6N1X2Y3Z4A5B6C7E1'));
        await t.ctx.briefs.sweep();
        const editor = t.network.signService({ sub: 'svc:orchestrator', aud: ['openvibe.news'], cap: ['news.review.ai_editor'] });
        const noCap = t.network.serviceToken('ai', ['news.story.publish']);

        await check('a brief reviewed by the AI editor is indexable and labelled, never as a person\'s review', async () => {
            const before = await t.get(`/briefs/${clusterId}`);
            assert.ok(before.text.includes('noindex'));
            const no = await t.api(`/briefs/${clusterId}/reviews`, { as: noCap, json: { kind: 'summary', tone: 'neutral', decision: 'approved' } });
            assert.strictEqual(no.status, 403, no.text);
            const r = await t.get(`/api/v1/briefs/${clusterId}/reviews`, { as: editor, json: { kind: 'summary', tone: 'neutral', decision: 'approved', note: 'Checked against the reports' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.deepStrictEqual([r.json().review.reviewerKind, r.json().review.reviewer], ['ai_editor', 'svc:orchestrator']);
            const page = await t.get(`/briefs/${clusterId}`);
            assert.ok(page.text.includes('<meta name="robots" content="index, follow">'), 'reviewed: indexable');
            assert.ok(AI_ON_PAGE.test(page.text), 'the brief says who checked it');
            assert.ok(!/reviewed by a person/i.test(page.text));
            assert.ok((await t.get('/sitemaps/briefs.xml')).text.includes(`/briefs/${clusterId}`));
        });

        await check('a person\'s approval of a brief still says "Reviewed by a person"', async () => {
            t.clock.advance(60 * 60 * 1000);
            t.ai.setNext(run('run_01J8Z3V9Q6N1X2Y3Z4A5B6C7E2'));
            await t.ctx.briefs.make(clusterId, { kind: 'summary', tone: 'neutral' });
            const r = await t.api(`/briefs/${clusterId}/reviews`, { json: { kind: 'summary', tone: 'neutral', decision: 'approved' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().review.reviewerKind, 'person');
            const page = await t.get(`/briefs/${clusterId}`);
            assert.ok(/Reviewed by a person <time/.test(page.text), 'the person\'s label is unchanged');
            assert.ok(!AI_ON_PAGE.test(page.text));
        });

        await check('an AI editor rejection stays in the queue and names its kind', async () => {
            t.clock.advance(60 * 60 * 1000);
            t.ai.setNext(run('run_01J8Z3V9Q6N1X2Y3Z4A5B6C7E3'));
            await t.ctx.briefs.make(clusterId, { kind: 'summary', tone: 'neutral' });
            const r = await t.get(`/api/v1/briefs/${clusterId}/reviews`, { as: editor, json: { kind: 'summary', tone: 'neutral', decision: 'rejected', note: 'Not accurate' } });
            assert.strictEqual(r.status, 201, r.text);
            const q = await t.api('/review-queue');
            const item = q.json().items.find((i) => i.id === clusterId);
            assert.ok(item, 'the AI editor\'s rejection leaves the brief in the person\'s queue');
            assert.deepStrictEqual([item.reviewed.kind, item.reviewed.decision, item.reviewed.by], ['ai_editor', 'rejected', 'svc:orchestrator']);
            const page = await t.get(`/briefs/${clusterId}`);
            assert.ok(page.text.includes('noindex'), 'rejected: still noindex');
        });
    } finally {
        await t.close();
    }
}

(async () => {
    await storyPart();
    await briefPart();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
