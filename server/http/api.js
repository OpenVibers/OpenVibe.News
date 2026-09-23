'use strict';

/**
 * /api/v1 — JSON for services (Network client-credentials tokens, audience openvibe.news, one
 * capability per route, acting for the editor in X-OV-Subject) and for browsers or apps with a
 * Network user JWT (judged as editors). Errors are problem+json.
 *
 *   GET    /topics                                  public
 *   POST   /topics                                  news.topic.manage       { name, slug?, description? }
 *   GET    /stories?topic=&limit=&offset=           public (published and retracted stories)
 *   GET    /stories/:id                             public for published; editors / news.story.read: everything
 *   POST   /stories                                 news.story.create       { cluster, headline, topic?, body | paragraphs? }
 *   GET    /stories/:id/revisions[/:n], /diff       news.story.read
 *   POST   /stories/:id/revisions                   news.story.revise       { headline?, body | paragraphs, expected_revision, topic?, noindex? }
 *                                                                           (X-OV-Origin: ai → an AI draft that needs a person's review)
 *   POST   /stories/:id/ai-drafts                   news.story.revise       { workflow: news.summarize_story | news.compare_perspectives }
 *   POST   /stories/:id/publish                     news.story.publish      { revision?, correction?: { kind, note } }
 *   POST   /stories/:id/unpublish                   news.story.publish
 *   POST   /stories/:id/retract                     news.story.retract      { note }
 *   POST   /stories/:id/reviews                     people only             { revision, decision, note? }
 *   POST   /stories/:id/flags                       news.story.revise       { kind: correction|update, note }
 *   POST   /stories/:id/sources                     news.source.attach      { item: nsi_… | itm_… }
 *   DELETE /stories/:id/sources/:item               news.source.attach
 *   POST   /stories/:id/perspectives                news.perspective.update { label, description? }
 *   DELETE /stories/:id/perspectives/:pid           news.perspective.update
 *   PUT    /stories/:id/sources/:item/perspective   news.perspective.update { perspective: per_… | null }
 *   POST   /stories/:id/timeline                    news.timeline.update    { occurred_on, text, source }
 *   DELETE /stories/:id/timeline/:eid               news.timeline.update
 *   GET    /clusters, /clusters/:id                 news.cluster.read
 *   POST   /clusters/:id/merge                      news.cluster.manage     { other, reason? }
 *   POST   /clusters/:id/split                      news.cluster.manage     { items: [...], reason? }
 *   POST   /clusters/audit/:auditId/reverse         news.cluster.manage     { reason? }
 *   GET    /source-items/:id                        news.cluster.read
 *   GET    /ingest                                  news.cluster.read       recent ingestion runs, source health, cursor
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, jsonBody, ApiError, privateNoStore } = require('./errors');
const { guard } = require('../auth/viewer');
const access = require('../domain/access');

function cors(origins) {
    const allowed = new Set(origins);
    return (req, res, next) => {
        const origin = req.get('origin');
        if (origin && allowed.has(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.vary('Origin');
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, traceparent, X-OpenVibe-Request-Id');
            res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
            res.set('Access-Control-Expose-Headers', 'X-OpenVibe-Request-Id');
            res.set('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
    };
}

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function itemDto(it) {
    if (!it) return null;
    return {
        id: it.id, sources_item: { service: 'sources', type: 'item', id: it.sources_item_id, revision: it.sources_revision },
        source_key: it.source_key, headline: it.headline, url: it.canonical_url, outlet: it.outlet, authors: parse(it.authors, []),
        published_at: it.published_at, summary: it.summary, summary_basis: it.summary_basis, license_note: it.license_note, terms_note: it.terms_note,
        status: it.status, duplicate_of: it.duplicate_of, dedupe: parse(it.dedupe, null), cluster_id: it.cluster_id, cluster_reason: parse(it.cluster_reason, null),
        retrieved_at: it.retrieved_at, first_seen_at: iso(it.first_seen_at), upstream_updated_at: iso(it.upstream_updated_at),
        removed: it.removed_at ? { at: iso(it.removed_at), reason: it.removed_reason } : null,
    };
}

function createApi(ctx) {
    const { config, stories, clusters, publication, reading, topics, ingest, viewers } = ctx;
    const router = express.Router();
    router.use(cors(config.apiCorsOrigins));
    router.use(viewers.middleware());
    router.use((req, res, next) => { privateNoStore(res); res.set('X-Robots-Tag', 'noindex'); next(); });

    const tp = (req) => ({ traceparent: req.ov && req.ov.traceparent });
    /** Reads for editors: a service passed its capability guard; a browser must be an editor. */
    const editorRead = (req) => { if (req.viewer.kind !== 'service') access.requireEditor(config, req.viewer); };

    function clusterDto(c, { full = false } = {}) {
        const out = {
            id: c.id, label: c.label, status: c.status, merged_into: c.merged_into, split_from: c.split_from,
            window: { start: iso(c.window_start), end: iso(c.window_end) }, created_by: c.created_by,
            key_terms: Object.entries(parse(c.terms, {})).sort(([a, x], [b, y]) => (y - x) || (a < b ? -1 : 1)).slice(0, 15).map(([t, n]) => ({ term: t, items: n })),
            key_entities: Object.entries(parse(c.entities, {})).sort(([a, x], [b, y]) => (y - x) || (a < b ? -1 : 1)).slice(0, 10).map(([t, n]) => ({ entity: t, items: n })),
            item_count: clusters.members(c.id).length,
        };
        if (full) Object.assign(out, { items: clusters.members(c.id).map(itemDto), audit: clusters.audit(c.id), stories: stories.byCluster(c.id).map((s) => ({ id: s.id, slug: s.slug, state: s.state })) });
        return out;
    }

    function storyDto(story) {
        const head = stories.head(story);
        const topic = publication.topicOf(story);
        return {
            id: story.id, slug: story.slug, url: publication.storyUrl(story), state: story.state, cluster_id: story.cluster_id,
            topic: topic ? topic.slug : null, working_headline: story.working_headline, noindex: Boolean(story.noindex),
            published_revision: story.published_revision, first_published_at: iso(story.first_published_at), published_at: iso(story.published_at), retracted_at: iso(story.retracted_at),
            head: head ? { revision: head.number, headline: head.fields.headline, paragraphs: head.fields.paragraphs, authorship: head.meta.authorship || null, system: head.meta.system || null, gaps: head.meta.gaps || null, author: head.author, created_at: head.createdAt } : null,
            publishable: head ? stories.problems(story, head) : [{ code: 'story.no_text', detail: 'Nothing has been written yet' }],
            indexability: story.published_revision ? (() => { const d = publication.decide(story, stories.revision(story, story.published_revision)); return { indexable: d.indexable, robots: d.robots, reasons: d.reasons }; })() : null,
            sources: stories.sources(story, { includeDetached: true }).map((s) => ({ n: s.n, perspective_id: s.perspective_id, detached_at: iso(s.detached_at), item: itemDto(s.item) })),
            timeline: stories.timeline(story).map((t) => ({ id: t.id, occurred_on: t.occurred_on, text: t.text, source_item_id: t.source_item_id })),
            perspectives: stories.perspectives(story).map((p) => ({ id: p.id, label: p.label, description: p.description })),
            flags: stories.flags(story).map((f) => ({ id: f.id, kind: f.kind, status: f.status, note: f.note, source_item_id: f.source_item_id, pending_revision: f.pending_revision, revision: f.revision, created_by: f.created_by, created_at: iso(f.created_at), resolved_at: iso(f.resolved_at) })),
        };
    }

    const mustStory = (req) => stories.mustGet(req.params.id);

    // ── Topics ──────────────────────────────────────────────

    router.get('/topics', run(() => ({ topics: topics.list().map((t) => ({ id: t.id, slug: t.slug, name: t.name, description: t.description, url: publication.abs(publication.topicPath(t)) })) })));

    router.post('/topics', guard('news.topic.manage'), jsonBody, run((req) => {
        access.requireEditor(config, req.viewer);
        const b = req.body || {};
        const r = topics.create({ name: b.name, slug: b.slug, description: b.description });
        return { topic: r.topic, created: r.created };
    }, (out) => (out.created ? 201 : 200)));

    // ── Stories ─────────────────────────────────────────────

    router.get('/stories', run(async (req) => {
        const topic = req.query.topic ? topics.bySlug(req.query.topic) : null;
        if (req.query.topic && !topic) throw new ApiError(404, 'topic.not_found', 'No such topic');
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const { total, stories: rows } = stories.listPublished({ topicId: topic ? topic.id : null, limit, offset });
        const items = await reading.listItems(rows);
        return { total, stories: items.map((i) => ({ id: i.story.id, url: publication.abs(i.url), headline: i.headline, state: i.story.state, topic: i.topic ? i.topic.name : null, sources: i.sourceCount, first_published_at: iso(i.published_at), updated_at: i.updated_at })) };
    }));

    router.get('/stories/:id', run(async (req) => {
        const story = mustStory(req);
        const privileged = req.viewer.kind === 'service'
            ? contracts.capabilities.grants(req.viewer.claims && req.viewer.claims.cap, 'news.story.read')
            : access.isEditor(config, req.viewer);
        if (privileged) {
            const m = story.published_revision ? await reading.storyModel(story) : null;
            return { story: storyDto(story), published: m ? reading.storyJson(m) : null };
        }
        if (!story.published_revision || (story.state !== 'published' && story.state !== 'retracted')) throw new ApiError(404, 'story.not_found', 'No such story');
        return { published: reading.storyJson(await reading.storyModel(story)) };
    }));

    router.post('/stories', guard('news.story.create'), jsonBody, run((req) => {
        const b = req.body || {};
        const out = stories.create(req.viewer, { cluster: b.cluster || b.cluster_id, headline: b.headline, topic: b.topic, slug: b.slug, body: b.body, paragraphs: b.paragraphs }, tp(req));
        return { story: storyDto(out.story), revision: out.revision ? out.revision.number : null };
    }, 201));

    router.get('/stories/:id/revisions', guard('news.story.read'), run((req) => {
        editorRead(req);
        const story = mustStory(req);
        return { revisions: stories.revisions(story, { limit: req.query.limit, before: req.query.before }).map((r) => ({ revision: r.number, kind: r.kind, author: r.author, message: r.message, created_at: r.createdAt, headline: r.fields.headline, authorship: r.meta.authorship || null, system: r.meta.system || null })) };
    }));
    router.get('/stories/:id/revisions/:n', guard('news.story.read'), run((req) => {
        editorRead(req);
        const story = mustStory(req);
        const rev = stories.revision(story, parseInt(req.params.n, 10));
        if (!rev) throw new ApiError(404, 'revision.not_found', 'No such revision');
        return { revision: rev, citations: ctx.store.citations.forRevision(story.id, rev.number), problems: stories.problems(story, rev) };
    }));
    router.get('/stories/:id/diff', guard('news.story.read'), run((req) => {
        editorRead(req);
        return { diff: stories.diff(mustStory(req), parseInt(req.query.from, 10), parseInt(req.query.to, 10), req.query.mode) };
    }));

    const write = (method, path, capGuard, fn, status = 200) => router[method](path, capGuard, jsonBody, run(async (req) => fn(req, mustStory(req), req.body || {}), status));

    write('post', '/stories/:id/revisions', guard('news.story.revise'), (req, story, b) => {
        const out = stories.revise(req.viewer, story, {
            headline: b.headline, body: b.body, paragraphs: b.paragraphs, expectedRevision: b.expected_revision ?? b.expectedRevision,
            topic: b.topic, noindex: b.noindex, message: b.message, authorship: b.authorship, gaps: b.gaps,
        }, tp(req));
        return { revision: out.revision.number, created: out.created, story: storyDto(out.story) };
    }, 201);
    write('post', '/stories/:id/ai-drafts', guard('news.story.revise'), async (req, story, b) => {
        const out = await stories.aiDraft(req.viewer, story, String(b.workflow || 'news.summarize_story'), tp(req));
        return { revision: out.revision.number, created: out.created, story: storyDto(out.story) };
    }, 201);
    write('post', '/stories/:id/publish', guard('news.story.publish'), (req, story, b) => {
        const out = stories.publish(req.viewer, story, { revision: b.revision, correction: b.correction }, tp(req));
        return { changed: out.changed, resolved_flags: out.resolved || [], story: storyDto(out.story) };
    });
    write('post', '/stories/:id/unpublish', guard('news.story.publish'), (req, story) => {
        const out = stories.unpublish(req.viewer, story, tp(req));
        return { changed: out.changed, story: storyDto(out.story) };
    });
    write('post', '/stories/:id/retract', guard('news.story.retract'), (req, story, b) => {
        const out = stories.retract(req.viewer, story, { note: b.note }, tp(req));
        return { changed: out.changed, story: storyDto(out.story) };
    });
    router.post('/stories/:id/reviews', jsonBody, run((req) => {
        const story = mustStory(req);
        const b = req.body || {};
        return { review: stories.review(req.viewer, story, { revision: b.revision, decision: b.decision, note: b.note }, tp(req)) };
    }, 201));
    write('post', '/stories/:id/flags', guard('news.story.revise'), (req, story, b) => ({ flag: stories.addFlag(req.viewer, story, { kind: b.kind, note: b.note }) }), 201);
    write('post', '/stories/:id/sources', guard('news.source.attach'), (req, story, b) => {
        const out = stories.attach(req.viewer, story, { item: b.item || b.item_id });
        return { n: out.n, created: out.created, item: itemDto(out.item) };
    }, 201);
    write('delete', '/stories/:id/sources/:item', guard('news.source.attach'), (req, story) => stories.detach(req.viewer, story, req.params.item));
    write('post', '/stories/:id/perspectives', guard('news.perspective.update'), (req, story, b) => ({ perspective: stories.addPerspective(req.viewer, story, { label: b.label, description: b.description }) }), 201);
    write('delete', '/stories/:id/perspectives/:pid', guard('news.perspective.update'), (req, story) => stories.removePerspective(req.viewer, story, req.params.pid));
    write('put', '/stories/:id/sources/:item/perspective', guard('news.perspective.update'), (req, story, b) => stories.assignPerspective(req.viewer, story, req.params.item, b.perspective || null));
    write('post', '/stories/:id/timeline', guard('news.timeline.update'), (req, story, b) => ({ entry: stories.addTimeline(req.viewer, story, { occurredOn: b.occurred_on ?? b.occurredOn, text: b.text, source: b.source }) }), 201);
    write('delete', '/stories/:id/timeline/:eid', guard('news.timeline.update'), (req, story) => stories.removeTimeline(req.viewer, story, req.params.eid));

    // ── Clusters, items, ingestion ──────────────────────────

    router.get('/clusters', guard('news.cluster.read'), run((req) => {
        editorRead(req);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        return { clusters: clusters.recent({ limit }).map((c) => clusterDto(c)) };
    }));
    router.get('/clusters/:id', guard('news.cluster.read'), run((req) => {
        editorRead(req);
        const c = clusters.get(req.params.id);
        if (!c) throw new ApiError(404, 'cluster.not_found', 'No such cluster');
        return { cluster: clusterDto(c, { full: true }) };
    }));
    router.post('/clusters/audit/:auditId/reverse', guard('news.cluster.manage'), jsonBody, run((req) => {
        access.requireEditor(config, req.viewer);
        const out = clusters.reverse(req.viewer, req.params.auditId, { reason: (req.body || {}).reason });
        return { audit: out.audit, clusters: out.clusters.map((c) => clusterDto(c)) };
    }));
    router.post('/clusters/:id/merge', guard('news.cluster.manage'), jsonBody, run((req) => {
        access.requireEditor(config, req.viewer);
        const b = req.body || {};
        const out = clusters.merge(req.viewer, req.params.id, b.other, { reason: b.reason });
        return { cluster: clusterDto(out.cluster, { full: true }), audit: out.audit };
    }));
    router.post('/clusters/:id/split', guard('news.cluster.manage'), jsonBody, run((req) => {
        access.requireEditor(config, req.viewer);
        const b = req.body || {};
        const out = clusters.split(req.viewer, req.params.id, b.items, { reason: b.reason });
        return { cluster: clusterDto(out.cluster), created: clusterDto(out.created, { full: true }), audit: out.audit };
    }, 201));
    router.get('/source-items/:id', guard('news.cluster.read'), run((req) => {
        editorRead(req);
        const it = ingest.get(req.params.id) || ingest.bySourcesId(req.params.id);
        if (!it) throw new ApiError(404, 'source_item.not_found', 'No such source item');
        return { item: itemDto(it) };
    }));
    router.get('/ingest', guard('news.cluster.read'), run((req) => {
        editorRead(req);
        return {
            cursor: ctx.store.getState('sources_cursor', 0),
            runs: ingest.runs({ limit: 50 }).map((r) => ({ ...r, counts: parse(r.counts, null), at: iso(r.at) })),
            sources: ingest.sourceStatus().map((s) => ({ ...s, stale: s.stale == null ? null : Boolean(s.stale), refreshed_at: iso(s.refreshed_at) })),
        };
    }));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createApi, itemDto };
