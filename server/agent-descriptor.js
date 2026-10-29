'use strict';
// What openvibe.news tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public stories, topics, wire and briefs, the
// JSON API under /api/v1, llms.txt/llms-full.txt and the sitemap. No OpenAPI document or separate
// documentation page is published, so neither is named.
module.exports = {
    id: 'news',
    name: 'OpenVibe.News',
    purpose: 'Source-backed news: editors write stories where every paragraph cites the reports it rests on, with AI briefs, a live wire of public sources and topic pages.',
    home: 'https://openvibe.news',
    site: 'openvibe.news',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: 'The public pages are not limited by the app; /api/v1 is limited to 240 requests a minute per address and sign-in attempts to 60 per 15 minutes',
    },
};
