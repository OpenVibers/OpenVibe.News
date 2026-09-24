'use strict';

/**
 * OpenVibe.News configuration. Every value comes from the environment (production:
 * /etc/openvibe/news.env, see .env.example). Only environment variable NAMES appear in code and
 * docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4820);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.news' : `http://localhost:${port}`));

    return {
        service: 'news',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        // Public origin: canonical URLs, feeds, sitemaps and JSON-LD are built from it.
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,

        dbPath: env.NEWS_DB_PATH || './data/news.db',

        // OpenVibe.Network: SSO (OAuth2 authorization server), JWKS, client-credentials tokens.
        networkUrl: trim(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'news',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile theme',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        // Signs the per-session form token (CSRF). Unset: a random per-process key.
        formSecret: env.NEWS_FORM_SECRET || '',

        // Editors: Network subjects (usr_…) who may create, revise, publish and retract stories and
        // manage clusters. A product role, not staff; staff with staff.editorial.manage are editors too.
        editors: list(env.NEWS_EDITORS),

        // OpenVibe.Sources: the news items News ingests (category=news). Reads need sources.item.read
        // (and, optionally, sources.source.read for outlet names and source health).
        sources: {
            internalUrl: trim(env.OV_SOURCES_INTERNAL_URL || 'http://127.0.0.1:4720'),
            category: 'news',
            // The cursor pull (backstop for missed webhook deliveries). 0 turns it off.
            pullIntervalMs: int(env.NEWS_PULL_INTERVAL_MS, 5 * 60 * 1000),
            pageSize: Math.min(Math.max(int(env.NEWS_PULL_PAGE_SIZE, 100), 1), 500),
            maxPagesPerRun: Math.max(int(env.NEWS_PULL_MAX_PAGES, 20), 1),
            timeoutMs: int(env.NEWS_SOURCES_TIMEOUT_MS, 8000),
        },

        // Licensing: the most of a source's own summary News stores and shows, and only when the
        // source's terms or licence note explicitly allows short summaries. Article bodies are never stored.
        licensing: {
            summaryMaxChars: Math.min(Math.max(int(env.NEWS_SUMMARY_MAX_CHARS, 280), 0), 500),
        },

        // Indexing: how many independent sources (distinct Sources sources, publishers' domains and
        // outlets, not copies of one report) a story's paragraphs must cite before search engines,
        // sitemaps and Search may treat it as indexable. Fewer: published, but noindex.
        indexing: {
            minIndependentSources: Math.max(int(env.NEWS_MIN_INDEPENDENT_SOURCES, 2), 1),
        },

        // Clustering: the time window a new item may join an existing cluster in.
        clustering: {
            windowMs: int(env.NEWS_CLUSTER_WINDOW_HOURS, 72) * 3600 * 1000,
        },

        // OpenVibe.Community: the comment thread of each public story (referenced by id, never
        // copied). Needs community.comment.write, and community.comment.moderate to hide a thread.
        community: {
            publicUrl: trim(env.OV_COMMUNITY_URL || 'https://openvibe.community'),
            internalUrl: trim(env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200'),
        },

        // OpenVibe.AI (optional): the news.summarize_story / news.compare_perspectives seams. Unset:
        // stories are written by editors from the source items; AI output only ever lands as a draft.
        ai: {
            internalUrl: trim(env.OV_AI_INTERNAL_URL || ''),
            waitMs: int(env.NEWS_AI_WAIT_MS, 30000),
        },

        // OpenVibe.Events: the outbox relay runs only when EVENTS_URL and the client secret are set;
        // the webhook (POST /internal/events) only when NEWS_EVENTS_SECRET is set.
        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
            webhookSecrets: list(env.NEWS_EVENTS_SECRET),
        },

        worker: {
            enabled: env.NEWS_WORKER !== 'off',
        },

        // Browser origins that may call /api/v1 with a Bearer Network JWT (no cookies cross origins).
        apiCorsOrigins: list(env.API_CORS_ORIGINS || 'https://openvibe.network,https://openvibe.live,https://openvibe.community'),
    };
}

module.exports = { load };
