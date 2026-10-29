'use strict';

/**
 * Crawl and machine-readability artifacts (roadmap §32.4/§32.5):
 *
 *   GET /robots.txt             sitemap location + explicit automated-consumer policy
 *   GET /llms.txt               orientation for language models
 *   GET /llms-full.txt          the same orientation plus one section per indexable story, each with
 *                               the editor's opening summary (never the source's full article text)
 *   GET /sitemap.xml            sitemap index over the three sections below
 *   GET /sitemaps/pages.xml     the site's own pages: front page, topics index, update log
 *   GET /sitemaps/stories.xml   published, INDEXABLE stories only (the gate decides: retracted,
 *                               unsupported, AI-unreviewed and noindex stories never appear);
 *                               lastmod = the story's latest publication time
 *   GET /sitemaps/topics.xml    topic pages that have indexable stories
 *
 * Built from the database on every request, never from the viewer.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const sharedSeo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { createHome } = require('../domain/home');

// The one-line site summary /llms.txt, /llms-full.txt and the home page all carry.
const SITE_SUMMARY = 'Source-backed news: AI briefs and editors\' stories where every paragraph cites the reports it rests on, a live wire of what public sources (collected by OpenVibe.Sources) report, and topic pages.';

// What /llms.txt and /llms-full.txt both say about how the publication works.
const SITE_DETAILS = 'OpenVibe.News is not an automatic headline generator. Each story page lists its sources (headline, outlet, author and date as the source published them, with links), a timeline, editor-assigned perspective groupings and its full correction history. Full article text from sources is never republished; at most a short summary where the source’s terms allow it. AI-assisted drafts are never published or indexed before a person reviews them. Retracted stories stay at their URL with a retraction notice and are noindex. Append .json to any story URL for the same content as data, including every claim’s source numbers and the Sources item ids.';

// The date /.well-known/security.txt must be refreshed by: one year on, a person re-reads and re-commits it.
const SECURITY_EXPIRES = '2027-10-29T00:00:00.000Z';

function createDiscoveryRoutes(ctx) {
    const { config, store, publication, topics, stories, clusters } = ctx;
    const homeData = ctx.home || createHome({ store });
    const router = express.Router();
    const { db } = store;
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);

    async function storyEntries() {
        // Revisions in one query, whatever the number of stories (no N+1).
        const rows = await db.prepare("SELECT * FROM news_stories WHERE state IN ('published','retracted') AND published_revision IS NOT NULL ORDER BY published_at DESC, id LIMIT 50000").all();
        const revs = await store.revisions.getMany(rows.map((s) => ({ entityId: s.id, revision: s.published_revision })));
        const out = [];
        for (const [i, story] of rows.entries()) out.push({ story, rev: revs[i], decision: await publication.decide(story, revs[i]) });
        return out;
    }

    const xml = (res, body) => res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(body);

    router.get('/robots.txt', (_req, res) => {
        const body = [
            '# openvibe.news automated-consumer policy: search engines and AI crawlers are welcome to read',
            '# published stories, topic pages, feeds and sitemaps. Every story page has a JSON twin',
            '# (<story URL>.json) with its claims, sources and provenance. The editor desk, clusters,',
            '# sign-in and the API are not for crawling. Pages decide their own indexability (meta robots /',
            '# X-Robots-Tag): retracted stories stay readable but are noindex. A Disallow is not a noindex.',
            sharedSeo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: ['/edit', '/clusters/', '/auth/', '/api/', '/internal/'] }),
            `# Agent manifest: ${abs('/.well-known/agent.json')}`,
        ].join('\n');
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(body);
    });

    // /.well-known/security.txt (RFC 9116, SEO-30). Contact, Expires and Canonical are required; Canonical is
    // this site's own, from the config, never a constant. Policy is listed only while
    // https://openvibe.network/security answers 200 (checked 2026-10-29). Expires is the date the file must be
    // refreshed by: one year on, a person re-reads and re-commits it.
    router.get('/.well-known/security.txt', (_req, res) => {
        res.type('text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=86400').send([
            'Contact: mailto:security@openvibe.network',
            `Expires: ${SECURITY_EXPIRES}`,
            'Preferred-Languages: en',
            `Canonical: ${abs('/.well-known/security.txt')}`,
            'Policy: https://openvibe.network/security',
            '',
        ].join('\n'));
    });

    router.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsTxt({
            name: 'OpenVibe.News',
            summary: SITE_SUMMARY,
            details: SITE_DETAILS,
            sections: [
                { title: 'Start here', links: [
                    { title: 'Latest stories', url: abs('/') },
                    { title: 'Topics', url: abs('/topics') },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                ] },
                { title: 'Feeds', links: [
                    { title: 'RSS', url: abs('/feed.xml') }, { title: 'Atom', url: abs('/atom.xml') }, { title: 'JSON Feed', url: abs('/feed.json') },
                    { title: 'Per topic', url: abs('/topics'), note: 'each topic has /topics/<slug>/feed.xml, atom.xml and feed.json' },
                ] },
                { title: 'Data', links: [{ title: 'Story JSON', url: abs('/'), note: 'append .json to any story URL (/stories/<slug>.json)' }] },
            ],
        }));
    });

    /**
     * The site's own pages, which exist whatever the news day looks like: the front page, the topics
     * index and the update log. A quiet stretch with no published story must not leave a crawler with
     * an empty sitemap: these are the pages that are always there, and the front page carries the wire,
     * the topics and the newest briefs even then. Each entry carries the decision the public router
     * makes for the same page (server/http/public.js), so a page that is noindex never appears here.
     */
    async function siteEntries() {
        const [{ total }, wire, stats, topicList] = await Promise.all([
            stories.listPublished({ limit: 1 }), clusters.wire({ limit: 8 }), homeData.stats(), topics.list(),
        ]);
        const newestTopic = topicList.length ? Math.max(...topicList.map((t) => t.updated_at)) : undefined;
        const page = (path, { empty = false, lastmod } = {}) => ({
            loc: abs(path),
            ...(lastmod ? { lastmod: new Date(lastmod).toISOString() } : {}),
            decision: seo.evaluate({
                state: empty ? 'draft' : 'published', visibility: empty ? 'private' : 'public',
                canonicalUrl: abs(path), wordCount: 0,
            }, { policy: { minWords: 0 }, now: store.now() }),
        });
        return [
            page('/', { empty: total === 0 && !wire.length && !stats.week, lastmod: newestTopic }),
            page('/topics', { lastmod: newestTopic }),
            page('/updates'),
        ];
    }

    router.get('/llms-full.txt', async (_req, res) => {
        // The gate decides for stories: only indexable ones, and only their editor's opening summary —
        // the source's full article text is never stored, so it can never appear here. The site's own
        // pages and the topics are always listed: they are what /llms.txt points at and what exists
        // when no story has been published yet.
        const [entries, topicList] = await Promise.all([storyEntries(), topics.list()]);
        const indexed = entries.filter((e) => e.decision.indexable);
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsFull({
            site: 'OpenVibe.News',
            summary: SITE_SUMMARY,
            base: config.baseUrl,
            maxBytes: 512 * 1024,
            sections: [
                { title: 'How OpenVibe.News works', url: abs('/'), body: SITE_DETAILS },
                {
                    title: 'Pages',
                    pages: [
                        { title: 'OpenVibe.News', url: abs('/'), text: SITE_SUMMARY },
                        { title: 'Topics', url: abs('/topics'), text: `The ${topicList.length} topics OpenVibe.News follows: ${topicList.map((t) => t.name).join(', ')}. Each topic page carries its stories, its AI briefs (labelled, noindex) and the wire of reports on it.` },
                        { title: 'What shipped on OpenVibe.News', url: abs('/updates'), text: 'Every change deployed to OpenVibe.News, newest first.' },
                    ],
                },
                {
                    title: 'Topics',
                    pages: topicList.map((t) => ({
                        title: t.name,
                        url: abs(publication.topicPath(t)),
                        text: t.description || `Stories, briefs and the wire on ${t.name}.`,
                    })),
                },
                {
                    title: 'Stories',
                    pages: indexed.map((e) => ({
                        title: e.rev.fields.headline,
                        url: publication.storyUrl(e.story),
                        text: e.rev.fields.paragraphs && e.rev.fields.paragraphs[0] ? e.rev.fields.paragraphs[0].text : '',
                    })),
                },
            ],
        }));
    });

    async function topicEntries(stories) {
        const byTopic = new Map();
        for (const e of stories) {
            if (!e.decision.indexable || !e.story.topic_id) continue;
            const t = e.story.published_at;
            if (!byTopic.has(e.story.topic_id) || byTopic.get(e.story.topic_id) < t) byTopic.set(e.story.topic_id, t);
        }
        const entries = [];
        for (const [id, storyLastmod] of byTopic) {
            const topic = await topics.byId(id);
            if (!topic || topic.status !== 'active') continue;
            const path = publication.topicPath(topic);
            const decision = seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: abs(path), wordCount: 0 }, { policy: { minWords: 0 }, now: store.now() });
            entries.push({ loc: abs(path), lastmod: new Date(Math.max(storyLastmod, topic.updated_at)).toISOString(), decision });
        }
        return entries;
    }

    router.get('/sitemap.xml', async (_req, res) => {
        const [entries, site] = await Promise.all([storyEntries(), siteEntries()]);
        const indexed = entries.filter((e) => e.decision.indexable);
        const topics = (await topicEntries(entries)).filter((e) => e.decision.indexable);
        const newest = (times) => {
            const known = times.filter((t) => Number.isFinite(t));
            return known.length ? new Date(Math.max(...known)).toISOString() : undefined;
        };
        xml(res, seo.sitemapIndex([
            { loc: abs('/sitemaps/pages.xml'), lastmod: newest(site.filter((e) => e.decision.indexable).map((e) => new Date(e.lastmod).getTime())) },
            { loc: abs('/sitemaps/stories.xml'), lastmod: newest(indexed.map((e) => new Date(e.story.published_at).getTime())) },
            { loc: abs('/sitemaps/topics.xml'), lastmod: newest(topics.map((e) => new Date(e.lastmod).getTime())) },
        ]));
    });

    // The site's own pages (never empty): what /llms.txt lists and a crawler reaches from the home page.
    router.get('/sitemaps/pages.xml', async (_req, res) => {
        xml(res, seo.sitemap((await siteEntries()).filter((e) => e.decision.indexable)).files[0]);
    });

    router.get('/sitemaps/stories.xml', async (_req, res) => {
        xml(res, seo.sitemap((await storyEntries()).map((e) => ({ loc: publication.storyUrl(e.story), lastmod: e.story.published_at, decision: e.decision }))).files[0]);
    });

    router.get('/sitemaps/topics.xml', async (_req, res) => {
        xml(res, seo.sitemap(await topicEntries(await storyEntries())).files[0]);
    });

    return router;
}

module.exports = { createDiscoveryRoutes, SITE_SUMMARY };
