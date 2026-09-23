'use strict';
/**
 * AI never owns publication truth: OpenVibe.AI output (news.summarize_story,
 * news.compare_perspectives) arrives only as a DRAFT revision with AI authorship; it cannot be
 * published or indexed until a person approves that revision; an editor's edit of it is
 * AI-assisted and needs a review too; uncited model claims are dropped, never kept; a failed run
 * makes no text; with no AI configured, editors write from the sources.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done, launchReports } = require('./helpers/boot');

(async () => {
    const t = await boot({ ai: true });
    const reports = launchReports(t.sources, { a: { fields: { body: 'SECRET-BODY-FOR-AI-5c1d' } } });
    await t.pull();
    const clusterId = t.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id).cluster_id;
    const story = (await t.api('/stories', { json: { cluster: clusterId, headline: 'Europa Clipper launch', topic: 'space' } })).json().story;
    const aiToken = t.network.serviceToken('ai', ['news.story.revise']);
    const aiHeaders = { 'x-ov-origin': 'ai' };
    const wf = { id: 'news.summarize_story', runId: 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7D8', version: 1 };
    const paragraphs = [
        { text: 'NASA launched the Europa Clipper spacecraft on a Falcon Heavy rocket from Kennedy Space Center, beginning a cruise of several years to Jupiter and its moon Europa.', sources: [reports.a.id, reports.b.id] },
        { text: 'According to NASA the spacecraft should arrive at Jupiter in 2030, after which it will make repeated close passes of Europa to study its ice shell and the ocean beneath.', sources: [reports.b.id] },
    ];

    await check('an AI delivery needs its workflow and cited paragraphs; it can only write drafts', async () => {
        let r = await t.get(`/api/v1/stories/${story.id}/revisions`, { as: aiToken, headers: aiHeaders, json: { paragraphs, expected_revision: 0 } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'story.ai_workflow_required');
        r = await t.get(`/api/v1/stories/${story.id}/revisions`, { as: aiToken, headers: aiHeaders, json: { paragraphs: [{ text: 'Uncited model claim.', sources: [] }], expected_revision: 0, authorship: { workflow: wf } } });
        assert.strictEqual(r.json().code, 'story.claim_unsourced');
        r = await t.get(`/api/v1/stories/${story.id}/publish`, { as: t.network.serviceToken('ai', ['news.story.publish']), headers: aiHeaders, json: {} });
        assert.strictEqual(r.status, 403, 'AI cannot publish');
    });

    let rev;
    await check('an AI draft is an AI-generated revision that cannot be published before a person reviews it', async () => {
        const r = await t.get(`/api/v1/stories/${story.id}/revisions`, { as: aiToken, headers: aiHeaders, json: { headline: 'Europa Clipper is on its way to Jupiter', paragraphs, expected_revision: 0, authorship: { workflow: wf } } });
        assert.strictEqual(r.status, 201, r.text);
        rev = r.json().revision;
        const head = r.json().story.head;
        assert.strictEqual(head.authorship.mode, 'ai');
        assert.strictEqual(head.authorship.workflow.id, 'news.summarize_story');
        assert.deepStrictEqual(head.authorship.authors, [], 'never attributed to a person');
        assert.ok(r.json().story.publishable.some((p) => p.code === 'story.review_required'));
        const pub = await t.api(`/stories/${story.id}/publish`, { json: { revision: rev } });
        assert.strictEqual(pub.status, 409);
        assert.strictEqual(pub.json().code, 'story.review_required');
        const svcReview = await t.get(`/api/v1/stories/${story.id}/reviews`, { as: aiToken, json: { revision: rev, decision: 'approved' } });
        assert.strictEqual(svcReview.status, 403, 'a service cannot review');
        const reader = await t.get(`/api/v1/stories/${story.id}/reviews`, { as: t.network.addUser('reader'), json: { revision: rev, decision: 'approved' } });
        assert.strictEqual(reader.status, 403, 'only an editor reviews');
    });

    await check('after a person approves, it publishes with an AI disclosure; Search sees ai_generated', async () => {
        let r = await t.api(`/stories/${story.id}/reviews`, { json: { revision: rev, decision: 'approved', note: 'Checked every claim against [1] and [2].' } });
        assert.strictEqual(r.status, 201, r.text);
        r = await t.api(`/stories/${story.id}/publish`, { json: { revision: rev } });
        assert.strictEqual(r.status, 200, r.text);
        const page = await t.get(`/stories/${story.slug}`);
        assert.match(page.text, /<strong>AI-generated\.<\/strong> AI-generated from the story’s source items by workflow news.summarize_story v1, reviewed by a person\./);
        assert.match(page.text, /<meta name="robots" content="index, follow">/);
        const doc = t.events('news.index_document.upserted').pop().payload;
        assert.strictEqual(doc.authorship, 'ai_generated');
        assert.ok(doc.provenance.some((p) => p.service === 'ai' && p.type === 'run' && p.id === wf.runId));
        const json = (await t.get(`/stories/${story.slug}.json`)).json();
        assert.strictEqual(json.authorship.reviewed_by_person, true);
    });

    await check('an editor’s edit of AI text is AI-assisted: it needs its own review before publication', async () => {
        let r = await t.api(`/stories/${story.id}/revisions`, { json: { body: `${paragraphs[0].text} [1, 2]\n\n${paragraphs[1].text} Arrival is planned for April 2030. [2]`, expected_revision: rev } });
        assert.strictEqual(r.status, 201, r.text);
        const n = r.json().revision;
        assert.strictEqual(r.json().story.head.authorship.mode, 'hybrid');
        r = await t.api(`/stories/${story.id}/publish`, { json: { revision: n } });
        assert.strictEqual(r.status, 409);
        assert.match(r.json().detail, /AI-assisted/);
        await t.api(`/stories/${story.id}/reviews`, { json: { revision: n, decision: 'approved' } });
        r = await t.api(`/stories/${story.id}/publish`, { json: { revision: n } });
        assert.strictEqual(r.status, 200, r.text);
        const page = await t.get(`/stories/${story.slug}`);
        assert.match(page.text, /Written with AI assistance\..*Reviewed by a person\./);
    });

    await check('the AI seam: a run becomes a draft; uncited claims are dropped as gaps; only stored fields are sent', async () => {
        const s2 = (await t.api('/stories', { json: { cluster: clusterId, headline: 'Second draft by AI' } })).json().story;
        t.ai.setNext({ status: 201, run: { id: 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7D9', status: 'succeeded', workflow: { key: 'news.summarize_story', version: 2 }, synthetic: false, provenance: { model: 'test-model' },
            output: { headline: 'Europa Clipper launches', summary: 'NASA launched Europa Clipper toward Jupiter.', key_points: [{ text: 'The probe will reach Jupiter in 2030.', citations: [1] }, { text: 'An uncited claim the model made up.', citations: [] }, { text: 'Out of range', citations: [9] }], timeline: [], citations: [0, 1], gaps: ['launch cost'] } } });
        const r = await t.api(`/stories/${s2.id}/ai-drafts`, { json: { workflow: 'news.summarize_story' } });
        assert.strictEqual(r.status, 201, r.text);
        const head = r.json().story.head;
        assert.strictEqual(head.authorship.mode, 'ai');
        assert.strictEqual(head.authorship.workflow.runId, 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7D9');
        assert.deepStrictEqual(head.paragraphs.map((p) => p.sources), [[1, 2], [2]]);
        assert.ok(!head.paragraphs.some((p) => /made up|Out of range/.test(p.text)));
        assert.ok(head.gaps.some((g) => /uncited key point/.test(g)));
        assert.ok(head.gaps.includes('launch cost'));
        const sent = JSON.stringify(t.ai.requests.pop());
        assert.ok(!sent.includes('SECRET-BODY-FOR-AI'), 'no body is ever sent to the model');
        assert.match(sent, /"source_type":"news.article"/);
        assert.strictEqual(t.ctx.stories.get(s2.id).state, 'draft');
        const edit = await t.get(`/edit/stories/${s2.id}`, { as: t.editor });
        assert.strictEqual(edit.status, 200, edit.text);
        assert.match(edit.text, /Ask OpenVibe.AI for a draft summary/);
        assert.match(edit.text, /is AI-generated \(news.summarize_story\)\. Read it against the sources before approving/);
        assert.match(edit.text, /What the AI draft could not support/);
        const csrf = t.csrf(t.editor);
        const rv = await t.get(`/edit/stories/${s2.id}/review`, { as: t.editor, form: { _csrf: csrf, revision: String(head.revision), decision: 'approved', note: '' } });
        assert.strictEqual(rv.status, 303, rv.text);
        assert.strictEqual(t.ctx.store.reviews.latest(s2.id, head.revision).reviewer, t.editor.subject);
    });

    await check('a stub-provider run is held (stub_provider) and a failed run makes no text', async () => {
        const s3 = (await t.api('/stories', { json: { cluster: clusterId, headline: 'Third draft' } })).json().story;
        t.ai.setNext({ status: 201, run: { id: 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7DA', status: 'failed', output: null } });
        let r = await t.api(`/stories/${s3.id}/ai-drafts`, { json: { workflow: 'news.compare_perspectives' } });
        assert.strictEqual(r.status, 502);
        assert.strictEqual(t.ctx.store.revisions.head(s3.id), null);
        t.ai.setNext({ status: 201, run: { id: 'run_01J8Z3V9Q6N1X2Y3Z4A5B6C7DB', status: 'succeeded', synthetic: true, workflow: { key: 'news.compare_perspectives', version: 1 },
            output: { question: 'How did outlets frame the launch?', perspectives: [{ label: 'Launch', summary: 'Outlets described the launch.', citations: [0, 1] }], agreements: [], disagreements: [], citations: [], gaps: [] } } });
        r = await t.api(`/stories/${s3.id}/ai-drafts`, { json: { workflow: 'news.compare_perspectives' } });
        assert.strictEqual(r.status, 201, r.text);
        const head = t.ctx.store.revisions.head(s3.id);
        assert.strictEqual(head.meta.authorship.stubProvider, true);
        const d = t.ctx.publication.decide(t.ctx.stories.get(s3.id), head, { state: 'published' });
        assert.ok(d.codes.includes('stub_provider') && d.codes.includes('ai_generated_unreviewed'));
        assert.strictEqual(t.db().prepare('SELECT COUNT(*) AS n FROM news_perspectives WHERE story_id = ?').get(s3.id).n, 0, 'AI never creates perspective labels');
    });

    await check('the published product events validate as events.event-envelope@1', async () => {
        for (const e of t.events(/^news\./)) {
            const v = contracts.validate('events.event-envelope@1', { ...e, event_id: e.event_id || 'evt_01J8Z3V9Q6N1X2Y3Z4A5B6C7D8' });
            assert.ok(v.valid, `${e.event_type}: ${JSON.stringify(v.errors)}`);
        }
    });

    await t.close();

    const t2 = await boot();
    await check('with no AI configured, the AI seam is off and says so', async () => {
        const r2 = launchReports(t2.sources);
        await t2.pull();
        const cid = t2.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(r2.a.id).cluster_id;
        const s = (await t2.api('/stories', { json: { cluster: cid, headline: 'Written by hand' } })).json().story;
        const r = await t2.api(`/stories/${s.id}/ai-drafts`, { json: { workflow: 'news.summarize_story' } });
        assert.strictEqual(r.status, 503);
        assert.strictEqual(r.json().code, 'ai.not_configured');
        const edit = await t2.get(`/edit/stories/${s.id}`, { as: t2.editor });
        assert.doesNotMatch(edit.text, /Ask OpenVibe.AI/);
    });
    await t2.close();
    done();
})();
