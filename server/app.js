'use strict';

/**
 * OpenVibe.News — Express app factory. server/index.js listens and starts the worker; tests build
 * their own instance with a temp database, an injectable clock and mock neighbours.
 *
 *   Pages (server-rendered, http/public.js)   Editor desk (forms, http/editor.js)   API (http/api.js)
 *   Discovery (robots, llms, sitemaps)         /auth/* (Network SSO)                 /internal/events (Events webhook)
 *   /api/health, /api/ready, /release.json, /metrics
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');

const configLib = require('./config');
const { openStore } = require('./db');
const { createAuthClient, createAuthRoutes } = require('./auth/sso');
const { createViewerResolver } = require('./auth/viewer');
const { createPeople } = require('./clients/network');
const { createSourcesClient } = require('./clients/sources');
const { createAi } = require('./clients/ai');
const { createCommunity } = require('./clients/community');
const { createNewsOutbox } = require('./events/outbox');
const { createPublication } = require('./domain/publication');
const { createDiscussion } = require('./domain/discussion');
const { createClusters } = require('./domain/clusters');
const { createIngest } = require('./domain/ingest');
const { createStories } = require('./domain/stories');
const { createTopics } = require('./domain/topics');
const { createReading } = require('./domain/reading');
const { createPublicRoutes } = require('./http/public');
const { createEditorRoutes } = require('./http/editor');
const { createApi } = require('./http/api');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createWebhook } = require('./http/webhook');
const { createNewsReadiness } = require('./observability');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/** opts: config, store | dbPath, now (clock), fetchImpl, auth (a createAuthClient-like object), log */
function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const store = opts.store || openStore(opts.dbPath || config.dbPath, { now: opts.now });

    const outbox = createNewsOutbox({ db: store.db, config, fetchImpl, now: store.now, log });
    const publication = createPublication({ store, config, outbox });
    const clusters = createClusters({ store, config, outbox });
    const sources = createSourcesClient({ config, fetchImpl });
    const ai = createAi({ config, fetchImpl });
    const community = createCommunity({ store, config, fetchImpl, log });
    const discussion = createDiscussion({ store, publication, community, log });
    const ingest = createIngest({ store, config, clusters, outbox, sources, discussion, log });
    const stories = createStories({ store, config, publication, clusters, outbox, ai, discussion, log });
    ingest.setStories(stories);
    const topics = createTopics({ store });
    // Topics are the only seed (idempotent: missing slugs are added, existing ones never changed).
    if (opts.seedTopics !== false) topics.seed();
    const people = createPeople({ store, config, fetchImpl });
    const reading = createReading({ store, config, stories, publication, people, topics });
    const auth = opts.auth || createAuthClient(config);
    const viewers = createViewerResolver({ auth, config, people });
    const worker = createWorker({ config, ingest, outbox, log });

    const ctx = { config, store, outbox, publication, clusters, sources, ai, community, discussion, ingest, stories, topics, people, reading, auth, viewers, worker };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'news', root: path.join(__dirname, '..') });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'news', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https:'],
                connectSrc: ["'self'", 'https://openvibe.network'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-news', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const readiness = createNewsReadiness({ store, auth, outbox, ingest, config, release: release.release });
    app.get('/api/ready', readiness.handler);

    // ── Events webhook (raw body; before any other body parser) ─
    app.use(createWebhook({ config, store, ingest, sources, log }));

    app.use(cookieParser());

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createAuthRoutes(config, auth));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'news', service: 'news', host: 'openvibe.news', name: 'OpenVibe.News' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', v && v === assetVersion(rel) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }), createApi(ctx));

    // ── Discovery, editor desk, public pages ────────────────
    app.use(createDiscoveryRoutes(ctx));
    const publicRoutes = createPublicRoutes(ctx);
    ctx.publicRoutes = publicRoutes;
    app.use(['/edit', '/clusters'], rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
    app.use(createEditorRoutes({ ...ctx, publicRoutes }));
    app.use(publicRoutes.router);
    app.use((req, res) => publicRoutes.notFound(req, res));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[News]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        res.set('Cache-Control', 'private, no-store');
        if (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
