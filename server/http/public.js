'use strict';

/**
 * Public, server-rendered routes — useful without JavaScript:
 *
 *   GET /                         published stories, newest first (retracted ones stay, labelled)
 *   GET /topics, /topics/:slug    topics and each topic's stories
 *   GET /stories/:slug            a story (…/:slug.json: the same story as data); ?group=outlet|perspective
 *                                 lets the reader choose how the source table is framed
 *   POST /stories/:slug/comments  comment (the story's Community thread) as the signed-in member
 *   GET /feed.xml, /atom.xml, /feed.json, /topics/:slug/feed.{xml,json}, /topics/:slug/atom.xml
 *
 * Comments are the story's OpenVibe.Community thread, read from Community on every render (never
 * copied here); a story that is not open for discussion (domain/discussion.js) shows no thread.
 *
 * Caching: a published story or a list rendered for an ANONYMOUS visitor is public for 60 s;
 * signed-in views, drafts, previews and refusals are `private, no-store`. Feeds are never
 * built for a viewer. Robots come from the gate: a retracted story is noindex with its reason.
 */
const express = require('express');
const frame = require('openvibe-shared/frame');
const rateLimit = require('express-rate-limit');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const { renderPage } = require('../render/layout');
const pages = require('../render/pages');
const access = require('../domain/access');
const { csrfToken, checkCsrf } = require('../auth/forms');

const PER_PAGE = 20;

function createPublicRoutes(ctx) {
    const { config, store, stories, publication, reading, topics, viewers, community, discussion } = ctx;
    const router = express.Router();
    router.use(viewers.middleware({ services: false }));

    function cacheHeaders(res, { cacheable, robots }) {
        res.vary('Cookie');
        res.vary('Authorization');
        if (cacheable) res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
        else res.set('Cache-Control', 'private, no-store');
        if (robots && robots !== 'index, follow') res.set('X-Robots-Tag', robots);
    }

    function send(req, res, status, page, { cacheable = false } = {}) {
        cacheHeaders(res, { cacheable: cacheable && req.viewer.kind === 'anonymous' && status === 200, robots: page.decision.robots });
        res.status(status).type('html').send(renderPage({ ...page, viewer: req.viewer, config, path: req.originalUrl, editor: access.isEditor(config, req.viewer) }));
    }

    /** A decision for a page that is not a story (lists, messages). */
    function pageDecision(path, { indexable = true, empty = false, query = [] } = {}) {
        return seo.evaluate({
            state: indexable ? 'published' : 'draft', visibility: indexable ? 'public' : 'private',
            canonicalUrl: seo.canonicalUrl(config.baseUrl, path, { query }), wordCount: 0, noindex: empty,
        }, { policy: { minWords: 0 }, now: store.now() });
    }

    function messagePage(req, res, status, heading, text, action) {
        send(req, res, status, { title: heading, decision: pageDecision(req.path, { indexable: false }), body: pages.message({ heading, text, action }) });
    }
    const notFound = (req, res) => messagePage(req, res, 404, 'Not found', 'There is nothing at this address.', { href: '/', label: 'OpenVibe.News' });

    const pageNumber = (req) => { const n = parseInt(req.query.page, 10); return Number.isInteger(n) && n > 0 ? n : 1; };
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    const FEEDS = [{ type: 'rss', label: 'RSS', file: 'feed.xml' }, { type: 'atom', label: 'Atom', file: 'atom.xml' }, { type: 'json', label: 'JSON Feed', file: 'feed.json' }];
    const feedsFor = (base) => FEEDS.map((f) => ({ type: f.type, label: f.label, href: `${base === '/' ? '' : base}/${f.file}`, title: f.label }));

    async function listing(req, res, { topic = null }) {
        const page = pageNumber(req);
        const path = topic ? publication.topicPath(topic) : '/';
        const { total, stories: rows } = stories.listPublished({ topicId: topic ? topic.id : null, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return notFound(req, res);
        const items = await reading.listItems(rows);
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        const feeds = feedsFor(path);
        const crumbs = topic ? [{ name: 'OpenVibe.News', url: '/' }, { name: 'Topics', url: '/topics' }, { name: topic.name }] : null;
        send(req, res, 200, {
            title: topic ? topic.name : null,
            description: topic ? (topic.description || `Stories on ${topic.name}.`) : 'Source-backed stories: every paragraph cites the reports it rests on.',
            decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }),
            canonical, feeds,
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            jsonLd: topic
                ? [seo.structuredData.breadcrumbs(crumbs.map((c) => ({ name: c.name, url: c.url ? publication.abs(c.url) : canonical })))]
                : [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'OpenVibe.News', url: publication.abs('/') }],
            body: topic ? pages.topicPage({ topic, items, pager, feeds, breadcrumbs: crumbs }) : pages.home({ items, pager, topics: topics.list(), feeds }),
        }, { cacheable: true });
    }

    // What shipped on OpenVibe.News: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(req, res, 200, {
        title: 'What shipped on OpenVibe.News', description: 'Every change deployed to OpenVibe.News, newest first.',
        decision: pageDecision('/updates'), canonical: `${config.baseUrl}/updates`,
        body: frame.updatesBody({ service: 'news', siteName: 'OpenVibe.News' }) + frame.shippedScript(),
    }, { cacheable: true }));
    router.get('/', wrap((req, res) => listing(req, res, {})));

    router.get('/topics', wrap(async (req, res) => {
        send(req, res, 200, { title: 'Topics', description: 'Topics on OpenVibe.News.', decision: pageDecision('/topics'), canonical: publication.abs('/topics'), body: pages.topicsIndex({ topics: topics.list() }) }, { cacheable: true });
    }));

    router.get('/topics/:slug', wrap(async (req, res) => {
        const topic = topics.bySlug(req.params.slug);
        if (!topic || topic.status !== 'active') return notFound(req, res);
        return listing(req, res, { topic });
    }));

    // ── Feeds (published stories only, never viewer-dependent) ─

    async function feed(req, res, kind, topic) {
        const items = await reading.feedItems({ topicId: topic ? topic.id : null, limit: 30 });
        const base = topic ? publication.topicPath(topic) : '/';
        const link = publication.abs(base);
        const title = topic ? `${topic.name} · OpenVibe.News` : 'OpenVibe.News';
        const description = topic ? (topic.description || `Stories on ${topic.name}`) : 'Source-backed stories from OpenVibe.News';
        const file = FEEDS.find((f) => f.type === kind).file;
        const feedUrl = publication.abs(`${base === '/' ? '' : base}/${file}`);
        res.set('Cache-Control', 'public, max-age=300');
        res.vary('Accept-Encoding');
        if (kind === 'rss') return res.type('application/rss+xml').send(seo.rssFeed({ title, link, description, feedUrl, language: 'en' }, items));
        if (kind === 'json') return res.type('application/feed+json').send(JSON.stringify(seo.jsonFeed({ title, link, feedUrl, description, language: 'en' }, items)));
        const listed = items.filter((i) => i.decision.listable);
        // An empty Atom feed still needs <updated>: the time the topic (or News' topic list) was set up, a real time.
        const updated = listed.length ? null : new Date(topic ? topic.updated_at : (store.db.prepare('SELECT MIN(created_at) AS t FROM news_topics').get().t || store.now())).toISOString();
        return res.type('application/atom+xml').send(seo.atomFeed({ title, link, feedUrl, id: `tag:openvibe.news,2026:${topic ? `topic/${topic.id}` : 'all'}`, subtitle: description, ...(updated ? { updated } : {}) }, items));
    }
    for (const f of FEEDS) {
        router.get(`/${f.file}`, wrap((req, res) => feed(req, res, f.type, null)));
        router.get(`/topics/:slug/${f.file}`, wrap((req, res) => {
            const topic = topics.bySlug(req.params.slug);
            if (!topic || topic.status !== 'active') return notFound(req, res);
            return feed(req, res, f.type, topic);
        }));
    }

    // ── Stories ─────────────────────────────────────────────

    /** The story's Community thread as the page shows it: { state: ok|closed|off|unavailable, … }. */
    async function commentsFor(req, story, headline) {
        const st = discussion.status(story);
        if (!st.open) return { state: 'closed', reason: st.reason };
        if (!community.enabled) return { state: 'off' };
        try {
            const threadId = await community.threadFor(story, headline, req.ov);
            if (!threadId) return { state: 'off' };
            const data = await community.readThread(threadId, { after: req.query.comments_after, ctx: req.ov });
            if (!data || !data.thread) throw new Error('Community returned no thread');
            return { state: 'ok', thread: data.thread, comments: Array.isArray(data.comments) ? data.comments : [], nextCursor: data.next_cursor || null, communityUrl: community.publicUrl };
        } catch (err) {
            console.warn(`[News] comments for ${story.id} unavailable: ${err.message}`);
            return { state: 'unavailable' };
        }
    }

    /** Render one story (also the editor's preview of a chosen revision). */
    async function renderStory(req, res, { story, rev = null, preview = false }) {
        const isEditor = access.isEditor(config, req.viewer);
        const m = await reading.storyModel(story, { rev, editorView: preview && isEditor });
        const group = ['outlet', 'perspective'].includes(req.query.group) ? req.query.group : 'number';
        const decision = preview ? publication.decide(story, m.rev, { state: 'draft' }) : m.decision;
        const crumbs = [{ name: 'OpenVibe.News', url: '/' }, ...(m.topic ? [{ name: m.topic.name, url: publication.topicPath(m.topic) }] : []), { name: m.headline }];
        const cacheable = !preview && (story.state === 'published' || story.state === 'retracted');
        const comments = preview ? null : await commentsFor(req, story, m.headline);
        const signedIn = req.viewer.kind === 'user' && Boolean(req.viewer.subject);
        send(req, res, 200, {
            title: m.retraction ? `Retracted: ${m.headline}` : m.headline,
            description: m.paragraphs[0] ? m.paragraphs[0].text.slice(0, 200) : undefined,
            decision, canonical: m.url, type: 'article',
            author: m.authors.length ? m.authors.map((a) => a.name).join(', ') : undefined,
            published: m.first_published_at, modified: m.updated_at,
            feeds: feedsFor('/'),
            jsonLd: preview ? [] : [reading.storyJsonLd(m), seo.structuredData.breadcrumbs(crumbs.map((c) => ({ name: c.name, url: c.url ? publication.abs(c.url) : m.url })))],
            body: pages.storyPage(m, {
                group, breadcrumbs: crumbs, jsonUrl: `${m.path}.json`,
                editUrl: isEditor ? `/edit/stories/${story.id}` : null,
                decisionNote: preview ? `preview of revision ${m.rev.number} · ${decision.robots}` : null,
                comments, signedIn, csrf: signedIn ? csrfToken(config, req.viewer) : '',
                loginUrl: `/auth/login?next=${encodeURIComponent(m.path)}`,
            }),
        }, { cacheable });
    }

    router.get('/stories/:slug', wrap(async (req, res) => {
        const asJson = req.params.slug.endsWith('.json');
        const slug = asJson ? req.params.slug.slice(0, -5) : req.params.slug;
        const story = stories.bySlug(slug);
        if (!story || !story.published_revision || (story.state !== 'published' && story.state !== 'retracted')) {
            if (story && story.state === 'unpublished') return messagePage(req, res, 410, 'Gone', 'This story was unpublished.', { href: '/', label: 'OpenVibe.News' });
            return notFound(req, res);
        }
        if (asJson) {
            const m = await reading.storyModel(story);
            cacheHeaders(res, { cacheable: req.viewer.kind === 'anonymous', robots: m.decision.robots });
            return res.json(reading.storyJson(m));
        }
        return renderStory(req, res, { story });
    }));

    router.post('/stories/:slug/comments', rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }), express.urlencoded({ extended: false, limit: '32kb' }), wrap(async (req, res) => {
        const story = stories.bySlug(req.params.slug);
        if (!story || !story.published_revision || (story.state !== 'published' && story.state !== 'retracted')) return notFound(req, res);
        const path = publication.storyPath(story);
        if (req.viewer.kind !== 'user' || !req.viewer.subject) return res.redirect(303, `/auth/login?next=${encodeURIComponent(path)}`);
        if (!checkCsrf(config, req.viewer, req.body && req.body._csrf)) return messagePage(req, res, 403, 'Form expired', 'Reload the story and try again.', { href: path, label: 'Back to the story' });
        if (!discussion.status(story).open) return messagePage(req, res, 409, 'Comments are closed', 'This story does not take comments.', { href: path, label: 'Back to the story' });
        if (!community.enabled) return messagePage(req, res, 503, 'Comments are unavailable', 'Comments are not connected on this server.', { href: path, label: 'Back to the story' });
        const message = String((req.body && req.body.message) || '').trim();
        if (!message) return res.redirect(303, `${path}#comments`);
        if (message.length > 5000) return messagePage(req, res, 422, 'Comment too long', 'A comment is at most 5000 characters.', { href: path, label: 'Back to the story' });
        try {
            const rev = store.revisions.get(story.id, story.published_revision);
            const threadId = await community.threadFor(story, rev && rev.fields.headline, req.ov);
            if (!threadId) throw new Error('no thread');
            await community.comment(threadId, req.viewer.subject, { message }, req.ov);
        } catch (err) {
            return messagePage(req, res, err.status === 429 ? 429 : 502, 'Comment not posted', `OpenVibe.Community did not accept the comment: ${err.message}`, { href: path, label: 'Back to the story' });
        }
        return res.redirect(303, `${path}#comments`);
    }));

    return { router, renderStory, notFound, messagePage, pageDecision, send };
}

module.exports = { createPublicRoutes, PER_PAGE };
