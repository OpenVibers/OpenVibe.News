'use strict';

/**
 * Public, server-rendered routes — useful without JavaScript:
 *
 *   GET /                         published stories, newest first (retracted ones stay, labelled)
 *   GET /topics, /topics/:slug    topics and each topic's stories
 *   GET /wire                     the wire: what the sources report, grouped, as the outlets' own headlines and links
 *                                 (the front page shows its latest clusters); labelled, noindex, follow
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
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const rateLimit = require('express-rate-limit');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const { renderPage } = require('../render/layout');
const pages = require('../render/pages');
const briefPages = require('../render/briefs');
const access = require('../domain/access');
const { csrfToken, checkCsrf } = require('../auth/forms');
const cache = require('openvibe-shared/cache-policy');
const { SITE_SUMMARY } = require('./discovery');
const homePage = require('../render/home');
const { pickListRules } = require('../render/short');
const { createHome } = require('../domain/home');

// The front page in search results and share cards (≤ 160 characters).
const HOME_DESCRIPTION = 'News you can check: AI briefs and stories where every paragraph links the reports it rests on, a live wire of public sources, and topic pages.';

const PER_PAGE = 20;

function createPublicRoutes(ctx) {
    const { config, store, stories, publication, reading, topics, viewers, community, discussion, clusters, briefs } = ctx;
    const homeData = ctx.home || createHome({ store });
    const router = express.Router();
    router.use(viewers.middleware({ services: false }));

    function cacheHeaders(res, { cacheable, robots }) {
        res.vary('Cookie');
        res.vary('Authorization');
        res.vary('Accept');
        if (cacheable) res.set('Cache-Control', cache.htmlHeaders({ maxAge: 60 }));
        else res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (robots && robots !== 'index, follow') res.set('X-Robots-Tag', robots);
    }

    function send(req, res, status, page, { cacheable = false } = {}) {
        cacheHeaders(res, { cacheable: cacheable && req.viewer.kind === 'anonymous' && status === 200, robots: page.decision.robots });
        // The public pages with a Markdown twin (server/agent-pages.js) name it in the head and in the Link header.
        const canonical = page.canonical || `${config.baseUrl}${req.path}`;
        const hasTwin = status === 200 && require('../agent-pages').TWIN_PATH_RE.test(req.path);
        const head = hasTwin ? require('openvibe-shared/agent-layer').linkHeaderTags(canonical, `${config.baseUrl}/llms.txt`) : null;
        if (head) res.set('Link', head.header);
        res.status(status).type('html').send(renderPage({ ...page, viewer: req.viewer, config, path: req.originalUrl, editor: access.isEditor(config, req.viewer), head: head ? head.head : '' }));
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

    // At most page 1000: a far page is a far OFFSET scan on a public route (past the last page answers 404 anyway).
    const pageNumber = (req) => { const n = parseInt(req.query.page, 10); return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 1; };
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    const FEEDS = [{ type: 'rss', label: 'RSS', file: 'feed.xml' }, { type: 'atom', label: 'Atom', file: 'atom.xml' }, { type: 'json', label: 'JSON Feed', file: 'feed.json' }];
    const feedsFor = (base) => FEEDS.map((f) => ({ type: f.type, label: f.label, href: `${base === '/' ? '' : base}/${f.file}`, title: f.label }));

    // A topic page also carries the AI briefs and the wire on it (server/domain/topic-match.js); with nothing on it in
    // the last 30 days, the latest from the wire overall, said as such.
    async function topicExtras(topic) {
        const wire = await clusters.topicWire(topic.slug, { limit: 20 });
        const ids = new Set(wire.map((c) => c.id));
        const topicBriefs = briefs && wire.length ? (await briefs.latest(200)).filter((b) => b.kind === 'summary' && !b.stub && b.paragraphs.length && ids.has(b.cluster_id)).slice(0, 6) : [];
        const briefed = new Set(topicBriefs.map((b) => b.cluster_id));
        return { topicBriefs, topicWire: wire.filter((c) => !briefed.has(c.id)).slice(0, 12), latestWire: wire.length ? [] : await clusters.wire({ limit: 6 }) };
    }

    async function listing(req, res, { topic = null }) {
        const page = pageNumber(req);
        const path = topic ? publication.topicPath(topic) : '/';
        const { total, stories: rows } = await stories.listPublished({ topicId: topic ? topic.id : null, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return notFound(req, res);
        const items = await reading.listItems(rows);
        // The front page's wire (render/pages.js): with clusters to show, the page is not empty even before a story.
        const wire = !topic && page === 1 ? await clusters.wire({ limit: 8 }) : [];
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        const feeds = feedsFor(path);
        // The front page (page 1): what OpenVibe.News is for, then everything it has to read (render/home.js).
        if (!topic && pager.page === 1) {
            const [stats, latestBriefs, topicList, tally, outlets] = await Promise.all([
                homeData.stats(), briefs ? briefs.latest(12) : [], topics.list(), homeData.topicTally(), homeData.outlets(),
            ]);
            const homeBriefs = latestBriefs.filter((b) => b.kind === 'summary' && !b.stub && b.paragraphs.length).slice(0, 6);
            return send(req, res, 200, {
                title: null, description: HOME_DESCRIPTION, summary: SITE_SUMMARY,
                decision: pageDecision(canonical, { empty: total === 0 && !wire.length && !stats.week, query: ['page'] }),
                canonical, feeds, next: pager.next ? pager.next.href : null,
                jsonLd: homePage.homeJsonLd({ abs: (p) => publication.abs(p), topics: topicList, outlets }),
                styles: [showcase.STYLESHEET], bodyClass: 'news-home',
                // The rule that shows the picked item of each pick list: one per item, written for this page.
                inlineStyles: [`@supports selector(:has(*)){@media (max-width:640px){${pickListRules('stories', items.length)}${pickListRules('briefs', homeBriefs.length)}${pickListRules('wire', wire.length)}${pickListRules('topics', topicList.length)}}}`],
                body: homePage.homeBody({
                    items, pager, feeds, stats, wire: pages.wireSection(wire), wireClusters: wire, topics: topicList, tally, outlets,
                    briefs: homeBriefs,
                }),
            }, { cacheable: true });
        }
        const crumbs = topic ? [{ name: 'OpenVibe.News', url: '/' }, { name: 'Topics', url: '/topics' }, { name: topic.name }] : null;
        send(req, res, 200, {
            title: topic ? topic.name : null,
            description: topic ? (topic.description || `Stories on ${topic.name}.`) : 'Source-backed stories: every paragraph cites the reports it rests on.',
            summary: topic ? undefined : SITE_SUMMARY,
            decision: pageDecision(canonical, { empty: total === 0 && !wire.length, query: ['page'] }),
            canonical, feeds,
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            jsonLd: topic
                ? [seo.structuredData.breadcrumbs(crumbs.map((c) => ({ name: c.name, url: c.url ? publication.abs(c.url) : canonical })))]
                : [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'OpenVibe.News', url: publication.abs('/') }],
            body: topic ? pages.topicPage({ topic, items, pager, feeds, breadcrumbs: crumbs, ...(pager.page === 1 ? await topicExtras(topic) : {}) })
                : pages.home({ items, pager, topics: await topics.list(), feeds }),
        }, { cacheable: true });
    }

    // What shipped on OpenVibe.News: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(req, res, 200, {
        title: 'What shipped on OpenVibe.News', description: 'Every change deployed to OpenVibe.News, newest first.',
        decision: pageDecision('/updates'), canonical: `${config.baseUrl}/updates`,
        body: frame.updatesBody({ service: 'news', siteName: 'OpenVibe.News' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`,
    }, { cacheable: true }));
    router.get('/', wrap(async (req, res) => await listing(req, res, {})));
    // The wire (render/pages.js): what the sources report, grouped, with the outlets' own headlines and links. Not
    // indexed: it is other publishers' headlines, not News' writing; its links are followed.
    router.get('/wire', wrap(async (req, res) => {
        const decision = seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: seo.canonicalUrl(config.baseUrl, '/wire'), wordCount: 0, noindex: true }, { policy: { minWords: 0 }, now: store.now() });
        send(req, res, 200, {
            title: 'The wire', description: 'What the sources OpenVibe.News follows report now, grouped, before an editor writes a story.',
            decision, canonical: `${config.baseUrl}/wire`, body: pages.wirePage({ clusters: await clusters.wire({ limit: 40 }) }),
        }, { cacheable: true });
    }));

    // ── AI briefs and the live view (domain/briefs.js, render/briefs.js) ──
    // Briefs are AI text: labelled, every paragraph cited, never a story and never indexed. A reader may ask for another
    // tone or the outlets' comparison (a POST, from this site, a few an address and a few dozen an hour in all), never a
    // crawler following a link.
    const noindex = (path) => seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: seo.canonicalUrl(config.baseUrl, path), wordCount: 0, noindex: true }, { policy: { minWords: 0 }, now: store.now() });
    const BRIEF_ID = /^clu_[0-9A-HJKMNP-TV-Z]{26}$/;
    const makeLimit = rateLimit({ windowMs: 10 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.ip,
        handler: (req, res) => messagePage(req, res, 429, 'Too many requests', 'Wait a few minutes, then ask again.', { href: `/briefs/${req.params.id}`, label: 'Back to the brief' }) });
    const runs = { hour: 0, at: 0 };
    const RUNS_AN_HOUR = 40;
    const sameSite = (req) => { const site = String(req.get('sec-fetch-site') || ''); return site ? site === 'same-origin' : String(req.get('origin') || '') === config.baseUrl; };
    const canMake = () => Boolean(briefs && config.briefs.enabled && ctx.ai && ctx.ai.enabled);

    router.get('/briefs', wrap(async (req, res) => {
        send(req, res, 200, { title: 'AI briefs', description: 'What the reports on a subject say, summarized by AI with every paragraph linked to its reports.', decision: noindex('/briefs'), canonical: `${config.baseUrl}/briefs`, localStyles: ['css/briefs.css'], body: briefPages.briefsIndex({ briefs: briefs ? await briefs.latest(40) : [] }) }, { cacheable: true });
    }));

    router.get('/briefs/:id', wrap(async (req, res) => {
        const id = String(req.params.id || '');
        const tone = briefPages.TONES.some(([t]) => t === req.query.tone) ? String(req.query.tone) : 'neutral';
        const got = BRIEF_ID.test(id) && briefs ? await briefs.get(id, { kind: 'summary', tone }) : null;
        if (!got || !got.reports.length) return notFound(req, res);
        const persp = await briefs.get(id, { kind: 'perspectives', tone: 'neutral' });
        const notice = req.query.made === '1' ? 'Written just now.' : (req.query.failed ? String(req.query.failed).slice(0, 200) : null);
        send(req, res, 200, {
            title: `${got.brief && got.brief.headline ? got.brief.headline : got.cluster.label} (AI brief)`,
            description: 'An AI summary of the reports on this subject, every paragraph linked to its reports.',
            decision: noindex(`/briefs/${id}`), canonical: `${config.baseUrl}/briefs/${id}`, localStyles: ['css/briefs.css'],
            body: briefPages.briefPage({ ...got, tone, perspectives: persp ? persp.brief : null, canMake: canMake(), notice }),
        }, { cacheable: !notice });
    }));

    router.post('/briefs/:id/make', makeLimit, express.urlencoded({ extended: false, limit: '4kb' }), wrap(async (req, res) => {
        const id = String(req.params.id || '');
        if (!BRIEF_ID.test(id) || !canMake()) return notFound(req, res);
        if (!sameSite(req)) return messagePage(req, res, 403, 'Not from this site', 'Ask from the brief\'s own page.', { href: `/briefs/${id}`, label: 'Back to the brief' });
        const kind = req.body && req.body.kind === 'perspectives' ? 'perspectives' : 'summary';
        const tone = briefPages.TONES.some(([t]) => t === (req.body && req.body.tone)) ? req.body.tone : 'neutral';
        const back = `/briefs/${id}${tone !== 'neutral' ? `?tone=${tone}&` : '?'}`;
        if (Date.now() - runs.at > 3_600_000) { runs.at = Date.now(); runs.hour = 0; }
        if (runs.hour >= RUNS_AN_HOUR) return res.redirect(303, `${back}failed=${encodeURIComponent('Many briefs were asked for this hour. Try again later.')}`);
        runs.hour += 1;
        try {
            await briefs.make(id, { kind, tone });
        } catch (err) {
            return res.redirect(303, `${back}failed=${encodeURIComponent(err.status === 422 ? err.message : 'OpenVibe.AI could not write it just now. Try again in a few minutes.')}`);
        }
        return res.redirect(303, `${back}made=1`);
    }));

    router.get('/live', wrap(async (req, res) => {
        const list = await clusters.wire({ limit: 40 });
        const now = store.now();
        const breaking = new Set(list.filter((c) => c.items.filter((i) => i.published_at && now - Date.parse(i.published_at) <= 2 * 3_600_000).length >= 3).map((c) => c.id));
        const briefIds = new Set(briefs ? (await briefs.latest(200)).map((b) => b.cluster_id) : []);
        res.set('Refresh', '60');
        send(req, res, 200, { title: 'Live', description: 'The newest reports from the sources OpenVibe.News follows, as they arrive, with what is breaking.', decision: noindex('/live'), canonical: `${config.baseUrl}/live`, localStyles: ['css/briefs.css'], body: briefPages.livePage({ clusters: list, briefIds, breaking }) }, { cacheable: true });
    }));

    router.get('/topics', wrap(async (req, res) => {
        const list = await topics.list();
        // It said "Topics on OpenVibe.News." (24 characters); it now names them.
        const names = list.map((t) => t.name).join(', ');
        const text = `The ${list.length} topics OpenVibe.News follows, each with its stories, briefs and wire: ${names}.`;
        const description = text.length <= 160 ? text : `${text.slice(0, 159).replace(/[\s,]+\S*$/, '')}…`;
        send(req, res, 200, { title: 'Topics', description, decision: pageDecision('/topics'), canonical: publication.abs('/topics'), body: pages.topicsIndex({ topics: list }) }, { cacheable: true });
    }));

    router.get('/topics/:slug', wrap(async (req, res) => {
        const topic = await topics.bySlug(req.params.slug);
        if (!topic || topic.status !== 'active') return notFound(req, res);
        return await listing(req, res, { topic });
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
        res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 }));
        res.vary('Accept-Encoding');
        if (kind === 'rss') return res.type('application/rss+xml').send(seo.rssFeed({ title, link, description, feedUrl, language: 'en' }, items));
        if (kind === 'json') return res.type('application/feed+json').send(JSON.stringify(seo.jsonFeed({ title, link, feedUrl, description, language: 'en' }, items)));
        const listed = items.filter((i) => i.decision.listable);
        // An empty Atom feed still needs <updated>: the time the topic (or News' topic list) was set up, a real time.
        const updated = listed.length ? null : new Date(topic ? topic.updated_at : ((await store.db.prepare('SELECT MIN(created_at) AS t FROM news_topics').get()).t || store.now())).toISOString();
        return res.type('application/atom+xml').send(seo.atomFeed({ title, link, feedUrl, id: `tag:openvibe.news,2026:${topic ? `topic/${topic.id}` : 'all'}`, subtitle: description, ...(updated ? { updated } : {}) }, items));
    }
    for (const f of FEEDS) {
        router.get(`/${f.file}`, wrap(async (req, res) => await feed(req, res, f.type, null)));
        router.get(`/topics/:slug/${f.file}`, wrap(async (req, res) => {
            const topic = await topics.bySlug(req.params.slug);
            if (!topic || topic.status !== 'active') return notFound(req, res);
            return await feed(req, res, f.type, topic);
        }));
    }

    // ── Stories ─────────────────────────────────────────────

    /** The story's Community thread as the page shows it: { state: ok|closed|off|unavailable, … }. */
    async function commentsFor(req, story, headline) {
        const st = await discussion.status(story);
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
        const decision = preview ? await publication.decide(story, m.rev, { state: 'draft' }) : m.decision;
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
        const story = await stories.bySlug(slug);
        if (!story || !story.published_revision || (story.state !== 'published' && story.state !== 'retracted')) {
            if (story && story.state === 'unpublished') return messagePage(req, res, 410, 'Gone', 'This story was unpublished.', { href: '/', label: 'OpenVibe.News' });
            return notFound(req, res);
        }
        if (asJson) {
            const m = await reading.storyModel(story);
            cacheHeaders(res, { cacheable: req.viewer.kind === 'anonymous', robots: m.decision.robots });
            return res.json(reading.storyJson(m));
        }
        return await renderStory(req, res, { story });
    }));

    // Per address (20 a minute), then per signed-in person (http/actor-limits.js) before the form is read.
    router.post('/stories/:slug/comments', rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }), ctx.limits.signedIn('news.discussion.comment'), express.urlencoded({ extended: false, limit: '32kb' }), wrap(async (req, res) => {
        const story = await stories.bySlug(req.params.slug);
        if (!story || !story.published_revision || (story.state !== 'published' && story.state !== 'retracted')) return notFound(req, res);
        const path = publication.storyPath(story);
        if (req.viewer.kind !== 'user' || !req.viewer.subject) return res.redirect(303, `/auth/login?next=${encodeURIComponent(path)}`);
        if (!checkCsrf(config, req.viewer, req.body && req.body._csrf)) return messagePage(req, res, 403, 'Form expired', 'Reload the story and try again.', { href: path, label: 'Back to the story' });
        if (!(await discussion.status(story)).open) return messagePage(req, res, 409, 'Comments are closed', 'This story does not take comments.', { href: path, label: 'Back to the story' });
        if (!community.enabled) return messagePage(req, res, 503, 'Comments are unavailable', 'Comments are not connected on this server.', { href: path, label: 'Back to the story' });
        const message = String((req.body && req.body.message) || '').trim();
        if (!message) return res.redirect(303, `${path}#comments`);
        if (message.length > 5000) return messagePage(req, res, 422, 'Comment too long', 'A comment is at most 5000 characters.', { href: path, label: 'Back to the story' });
        try {
            const rev = await store.revisions.get(story.id, story.published_revision);
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
