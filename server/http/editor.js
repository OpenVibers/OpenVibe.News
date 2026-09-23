'use strict';

/**
 * The editor desk as plain HTML forms (no JavaScript needed). Editors only (NEWS_EDITORS or Network
 * admins, via Network SSO); every POST carries the form token. Every response is private, no-store
 * and noindex.
 *
 *   GET  /edit                                   dashboard: flags, stories, clusters, ingestion
 *   POST /edit/pull                              run the Sources cursor pull now
 *   GET  /clusters/:id                           a cluster: items, why each is there, history
 *   POST /clusters/:id/{merge,split,stories}     merge another in, split items off, open a story
 *   POST /clusters/audit/:aid/reverse            undo a merge or split
 *   GET  /edit/stories/:id                       the story editor
 *   POST /edit/stories/:id/{revise,publish,unpublish,retract,review,flag,attach,detach,assign,
 *                           perspective,perspective/remove,timeline,timeline/remove,ai}
 *   GET  /edit/stories/:id/preview?revision=N    GET /edit/stories/:id/diff?from&to
 *   GET|POST /edit/topics
 */
const express = require('express');
const { renderPage } = require('../render/layout');
const editor = require('../render/editor');
const { csrfToken, checkCsrf } = require('../auth/forms');
const { asApiError } = require('./errors');
const access = require('../domain/access');

/** Checkbox + hidden fallback arrive as ['1','0']; a repeated text field keeps its last value. */
const one = (v) => (Array.isArray(v) ? (v.includes('1') ? '1' : v[v.length - 1]) : v);

function createEditorRoutes(ctx) {
    const { config, store, stories, clusters, topics, ingest, publication, viewers, publicRoutes, ai } = ctx;
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '300kb' });
    router.use(['/edit', '/clusters'], viewers.middleware({ services: false }), (req, res, next) => {
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Robots-Tag', 'noindex, nofollow');
        res.vary('Cookie');
        if (req.viewer.kind !== 'user') {
            if (req.method === 'GET') return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
            return publicRoutes.messagePage(req, res, 401, 'Sign in first', 'Your session ended. Sign in and try again.', { href: `/auth/login?next=${encodeURIComponent('/edit')}`, label: 'Sign in' });
        }
        if (!access.isEditor(config, req.viewer)) return publicRoutes.messagePage(req, res, 403, 'Editors only', 'The editor desk is for OpenVibe.News editors.', { href: '/', label: 'OpenVibe.News' });
        next();
    });
    router.post(['/edit/*', '/clusters/*'], form, (req, res, next) => {
        if (!checkCsrf(config, req.viewer, req.body && one(req.body._csrf))) return publicRoutes.messagePage(req, res, 403, 'Form expired', 'Reload the page and submit it again.');
        next();
    });

    const back = (req) => {
        try { const u = new URL(req.get('referer') || '', config.baseUrl); return u.origin === new URL(config.baseUrl).origin && /^\/(edit|clusters)/.test(u.pathname) ? u.pathname : '/edit'; } catch { return '/edit'; }
    };
    const wrap = (fn) => async (req, res, next) => {
        try { await fn(req, res, next); } catch (err) {
            const e = asApiError(err);
            if (!e) return next(err);
            const text = e.code === 'revision.conflict'
                ? `Someone saved revision ${e.extra && e.extra.current} while you were editing. Your text was not saved: open the story again, re-apply your change and save.`
                : e.message;
            publicRoutes.messagePage(req, res, e.status, 'That did not work', text, { href: back(req), label: 'Back' });
        }
    };
    function page(req, res, title, body, status = 200) {
        const decision = publicRoutes.pageDecision(req.path, { indexable: false });
        res.status(status).type('html').send(renderPage({ title, body, decision, viewer: req.viewer, config, path: req.originalUrl, bodyClass: 'editor', editor: true }));
    }
    const csrf = (req) => csrfToken(config, req.viewer);
    const flashOf = (req) => (req.query.saved ? { kind: 'ok', text: String(req.query.saved).slice(0, 300) } : null);
    const done = (res, path, text) => res.redirect(303, `${path}?saved=${encodeURIComponent(text)}`);
    const tp = (req) => ({ traceparent: req.ov && req.ov.traceparent });
    const input = (body) => { const b = {}; for (const [k, v] of Object.entries(body || {})) b[k] = one(v); return b; };

    // ── Dashboard ───────────────────────────────────────────

    router.get('/edit', wrap(async (req, res) => {
        const flags = store.db.prepare(`SELECT f.*, s.working_headline FROM news_editorial_flags f JOIN news_stories s ON s.id = f.story_id
                                        WHERE f.status = 'open' ORDER BY f.created_at DESC LIMIT 100`).all();
        page(req, res, 'Editor desk', editor.dashboard({
            clusters: clusters.recent({ limit: 40 }).map((c) => ({ ...c, count: clusters.members(c.id).length })),
            stories: stories.listAll({ limit: 100 }), flags, runs: ingest.runs({ limit: 20 }), sources: ingest.sourceStatus(),
            cursor: store.getState('sources_cursor', 0), csrf: csrf(req), message: flashOf(req), aiEnabled: Boolean(ai && ai.enabled),
            pullOn: Boolean(config.worker.enabled && config.sources.pullIntervalMs),
        }));
    }));

    router.post('/edit/pull', wrap(async (req, res) => {
        const r = await ingest.pull();
        done(res, '/edit', r.ok ? `Pulled: ${JSON.stringify(r.counts)}` : `Pull failed (${r.error}): ${r.detail}`);
    }));

    router.get('/edit/topics', wrap(async (req, res) => page(req, res, 'Topics', editor.topicsPage({ topics: topics.list(), csrf: csrf(req), message: flashOf(req) }))));
    router.post('/edit/topics', wrap(async (req, res) => {
        const b = input(req.body);
        const r = topics.create({ name: b.name, description: b.description });
        done(res, '/edit/topics', r.created ? `Added ${r.topic.name}` : `${r.topic.name} already exists`);
    }));

    // ── Clusters ────────────────────────────────────────────

    function mustCluster(req, res) {
        const c = clusters.get(req.params.id);
        if (!c) { publicRoutes.notFound(req, res); return null; }
        return c;
    }

    router.get('/clusters/:id', wrap(async (req, res) => {
        const c = mustCluster(req, res);
        if (!c) return;
        page(req, res, `Cluster: ${c.label}`, editor.clusterPage({
            cluster: c, items: clusters.members(c.id), audit: clusters.audit(c.id),
            others: clusters.recent({ limit: 100 }).filter((o) => o.id !== c.id), storiesOf: stories.byCluster(c.id),
            topics: topics.list(), csrf: csrf(req), message: flashOf(req),
        }));
    }));
    router.post('/clusters/:id/merge', wrap(async (req, res) => {
        const b = input(req.body);
        clusters.merge(req.viewer, req.params.id, b.other, { reason: b.reason });
        done(res, `/clusters/${req.params.id}`, `Merged ${b.other} into this cluster`);
    }));
    router.post('/clusters/:id/split', wrap(async (req, res) => {
        const items = [].concat((req.body && req.body.items) || []);
        const out = clusters.split(req.viewer, req.params.id, items, { reason: one(req.body.reason) });
        done(res, `/clusters/${out.created.id}`, `Split ${items.length} items off ${req.params.id}`);
    }));
    router.post('/clusters/audit/:aid/reverse', wrap(async (req, res) => {
        const out = clusters.reverse(req.viewer, req.params.aid, { reason: one(req.body.reason) });
        done(res, `/clusters/${out.clusters[0].id}`, `Reversed (${out.audit.action.replace('_', ' ')})`);
    }));
    router.post('/clusters/:id/stories', wrap(async (req, res) => {
        const b = input(req.body);
        const out = stories.create(req.viewer, { cluster: req.params.id, headline: b.headline, topic: b.topic || null }, tp(req));
        done(res, `/edit/stories/${out.story.id}`, 'Story opened. Write the text; every paragraph cites its sources.');
    }));

    // ── Stories ─────────────────────────────────────────────

    function mustStory(req, res) {
        const s = stories.get(req.params.id);
        if (!s) { publicRoutes.notFound(req, res); return null; }
        return s;
    }

    router.get('/edit/stories/:id', wrap(async (req, res) => {
        const story = mustStory(req, res);
        if (!story) return;
        const head = stories.head(story);
        page(req, res, story.working_headline, editor.storyEditor({
            story, head, problems: head ? stories.problems(story, head) : [],
            sources: stories.sources(story, { includeDetached: true }), timeline: stories.timeline(story), perspectives: stories.perspectives(story),
            flags: stories.flags(story), revisions: stories.revisions(story, { limit: 100 }), topics: topics.list(), topic: publication.topicOf(story),
            csrf: csrf(req), message: flashOf(req), aiEnabled: Boolean(ai && ai.enabled), publicUrl: publication.storyPath(story),
            decision: story.published_revision ? publication.decide(story, stories.revision(story, story.published_revision)) : null,
        }));
    }));

    router.get('/edit/stories/:id/preview', wrap(async (req, res) => {
        const story = mustStory(req, res);
        if (!story) return;
        const n = parseInt(req.query.revision, 10);
        const rev = Number.isInteger(n) ? stories.revision(story, n) : stories.head(story);
        if (!rev) return publicRoutes.notFound(req, res);
        await publicRoutes.renderStory(req, res, { story, rev, preview: true });
        return undefined;
    }));

    router.get('/edit/stories/:id/diff', wrap(async (req, res) => {
        const story = mustStory(req, res);
        if (!story) return;
        page(req, res, 'Diff', editor.diffPage({ story, diff: stories.diff(story, parseInt(req.query.from, 10), parseInt(req.query.to, 10), 'word') }));
    }));

    const act = (path, fn) => router.post(`/edit/stories/:id/${path}`, wrap(async (req, res) => {
        const story = mustStory(req, res);
        if (!story) return;
        const text = await fn(req, story, input(req.body));
        done(res, `/edit/stories/${story.id}`, text);
    }));

    act('revise', (req, story, b) => {
        const out = stories.revise(req.viewer, story, { headline: b.headline, body: b.body, expectedRevision: b.expectedRevision, topic: b.topic, noindex: b.noindex, message: b.message }, tp(req));
        return out.created ? `Saved revision ${out.revision.number}` : 'Nothing changed';
    });
    act('publish', (req, story, b) => {
        const correction = b.correctionKind || b.correctionNote ? { kind: b.correctionKind || 'correction', note: b.correctionNote } : undefined;
        const out = stories.publish(req.viewer, story, { revision: b.revision, correction }, tp(req));
        return out.changed ? `Published revision ${out.story.published_revision}` : 'Already published';
    });
    act('unpublish', (req, story) => (stories.unpublish(req.viewer, story, tp(req)).changed ? 'Unpublished' : 'Not published'));
    act('retract', (req, story, b) => (stories.retract(req.viewer, story, { note: b.note }, tp(req)).changed ? 'Retracted' : 'Already retracted'));
    act('review', (req, story, b) => { stories.review(req.viewer, story, { revision: b.revision, decision: b.decision, note: b.note }, tp(req)); return `Review recorded for revision ${b.revision}`; });
    act('flag', (req, story, b) => { stories.addFlag(req.viewer, story, { kind: b.kind, note: b.note }); return 'Note added; it is published with the next publication'; });
    act('attach', (req, story, b) => `Attached as [${stories.attach(req.viewer, story, { item: b.item }).n}]`);
    act('detach', (req, story, b) => `Detached [${stories.detach(req.viewer, story, b.item).n}]`);
    act('assign', (req, story, b) => { stories.assignPerspective(req.viewer, story, b.item, b.perspective || null); return 'Perspective set'; });
    act('perspective', (req, story, b) => { stories.addPerspective(req.viewer, story, { label: b.label, description: b.description }); return 'Perspective added'; });
    act('perspective/remove', (req, story, b) => { stories.removePerspective(req.viewer, story, b.perspective); return 'Perspective removed'; });
    act('timeline', (req, story, b) => { stories.addTimeline(req.viewer, story, { occurredOn: b.occurredOn, text: b.text, source: b.source }); return 'Timeline entry added'; });
    act('timeline/remove', (req, story, b) => { stories.removeTimeline(req.viewer, story, b.entry); return 'Timeline entry removed'; });
    act('ai', async (req, story, b) => {
        const out = await stories.aiDraft(req.viewer, story, b.workflow, tp(req));
        return `AI draft saved as revision ${out.revision.number}: review it before publishing`;
    });

    return router;
}

module.exports = { createEditorRoutes };
