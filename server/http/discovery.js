'use strict';

/**
 * Crawl and machine-readability artifacts (roadmap §32.4/§32.5):
 *
 *   GET /robots.txt             sitemap location + explicit automated-consumer policy
 *   GET /llms.txt               orientation for language models
 *   GET /sitemap.xml            sitemap index over the two sections below
 *   GET /sitemaps/stories.xml   published, INDEXABLE stories only (the gate decides: retracted,
 *                               unsupported, AI-unreviewed and noindex stories never appear);
 *                               lastmod = the published revision's real time
 *   GET /sitemaps/topics.xml    topic pages that have indexable stories
 *
 * Built from the database on every request, never from the viewer.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const sharedSeo = require('openvibe-shared/seo');

function createDiscoveryRoutes({ config, store, publication, topics }) {
    const router = express.Router();
    const { db } = store;
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);

    function storyEntries() {
        return db.prepare("SELECT * FROM news_stories WHERE state IN ('published','retracted') AND published_revision IS NOT NULL ORDER BY published_at DESC LIMIT 50000").all()
            .map((story) => {
                const rev = store.revisions.get(story.id, story.published_revision);
                return { story, rev, decision: publication.decide(story, rev) };
            });
    }

    const xml = (res, body) => res.type('application/xml').set('Cache-Control', 'public, max-age=300').send(body);

    router.get('/robots.txt', (_req, res) => {
        const body = [
            '# openvibe.news automated-consumer policy: search engines and AI crawlers are welcome to read',
            '# published stories, topic pages, feeds and sitemaps. Every story page has a JSON twin',
            '# (<story URL>.json) with its claims, sources and provenance. The editor desk, clusters,',
            '# sign-in and the API are not for crawling. Pages decide their own indexability (meta robots /',
            '# X-Robots-Tag): retracted stories stay readable but are noindex. A Disallow is not a noindex.',
            sharedSeo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: ['/edit', '/clusters/', '/auth/', '/api/', '/internal/'] }),
        ].join('\n');
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(body);
    });

    router.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(sharedSeo.llmsTxt({
            name: 'OpenVibe.News',
            summary: 'A source-backed publication: stories written by OpenVibe.News editors from source items collected by OpenVibe.Sources. Every paragraph cites the sources it rests on.',
            details: 'OpenVibe.News is not an automatic headline generator. Each story page lists its sources (headline, outlet, author and date as the source published them, with links), a timeline, editor-assigned perspective groupings and its full correction history. Full article text from sources is never republished; at most a short summary where the source’s terms allow it. AI-assisted drafts are never published or indexed before a person reviews them. Retracted stories stay at their URL with a retraction notice and are noindex. Append .json to any story URL for the same content as data, including every claim’s source numbers and the Sources item ids.',
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

    router.get('/sitemap.xml', (_req, res) => {
        const entries = storyEntries().filter((e) => e.decision.indexable);
        const newest = entries.length ? entries.map((e) => e.rev.createdAt).sort().pop() : null;
        xml(res, seo.sitemapIndex([
            { loc: abs('/sitemaps/stories.xml'), ...(newest ? { lastmod: newest } : {}) },
            { loc: abs('/sitemaps/topics.xml'), ...(newest ? { lastmod: newest } : {}) },
        ]));
    });

    router.get('/sitemaps/stories.xml', (_req, res) => {
        xml(res, seo.sitemap(storyEntries().map((e) => ({ loc: publication.storyUrl(e.story), lastmod: e.rev.createdAt, decision: e.decision }))).files[0]);
    });

    router.get('/sitemaps/topics.xml', (_req, res) => {
        const byTopic = new Map();
        for (const e of storyEntries()) {
            if (!e.decision.indexable || !e.story.topic_id) continue;
            const t = e.rev.createdAt;
            if (!byTopic.has(e.story.topic_id) || byTopic.get(e.story.topic_id) < t) byTopic.set(e.story.topic_id, t);
        }
        const entries = [];
        for (const [id, lastmod] of byTopic) {
            const topic = topics.byId(id);
            if (!topic || topic.status !== 'active') continue;
            const path = publication.topicPath(topic);
            const decision = seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: abs(path), wordCount: 0 }, { policy: { minWords: 0 }, now: store.now() });
            entries.push({ loc: abs(path), lastmod, decision });
        }
        xml(res, seo.sitemap(entries).files[0]);
    });

    return router;
}

module.exports = { createDiscoveryRoutes };
