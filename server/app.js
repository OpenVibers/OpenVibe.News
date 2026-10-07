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

const { createSsoClient } = require('openvibe-sdk/sso');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createSourcesClient } = require('openvibe-publishing/ingest');
const { createIndexNow } = require('openvibe-shared/indexnow');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createViewerResolver } = require('./auth/viewer');
const { createPeople } = require('./clients/network');
const { createAi } = require('./clients/ai');
const { createCommunity } = require('./clients/community');
const { createPublication } = require('./domain/publication');
const { createDiscussion } = require('./domain/discussion');
const { createClusters } = require('./domain/clusters');
const { createIngest } = require('./domain/source-items');
const { createStories } = require('./domain/stories');
const { createTopics } = require('./domain/topics');
const { createReading } = require('./domain/reading');
const { createPublicRoutes } = require('./http/public');
const { createEditorRoutes } = require('./http/editor');
const { createApi } = require('./http/api');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createEvents } = require('./http/events');
const { createActorLimits } = require('./http/actor-limits');
const { createNewsReadiness } = require('./observability');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/** opts: config, store, now (clock), fetchImpl, auth (an openvibe-sdk/sso client), log,
 *  limitsNow (the per-actor limiter's clock, tests; default the wall clock) */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test, a script) hands in a store.
    const store = opts.store || await openStore(config, { now: opts.now, log });

    const outbox = createServiceOutbox({
        db: store.db, source: 'news',
        eventsUrl: config.events.url,
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs, log, now: store.now,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    // IndexNow (openvibe-shared/indexnow): created once at boot from INDEXNOW_KEY; unset → off
    // (nothing mounted, nothing sent). The key file is served at /<key>.txt and publication.js
    // pings the engines when an indexable page appears, changes or goes away.
    const indexnow = opts.indexnow || createIndexNow({ host: config.baseUrl, key: config.indexnow.key, ...(fetchImpl ? { fetch: fetchImpl } : {}), log });
    const publication = createPublication({ store, config, outbox, indexnow });
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
    if (opts.seedTopics !== false) await topics.seed();
    const people = createPeople({ store, config, fetchImpl });
    const reading = createReading({ store, config, stories, publication, people, topics });
    const auth = opts.auth || createSsoClient({
        site: 'news',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl,
        issuer: config.issuer || config.networkUrl,
        secureCookies: config.cookies.secure,
    });
    const viewers = createViewerResolver({ auth, config, people });
    const worker = createWorker({ config, ingest, outbox, log });

    const ctx = { config, store, outbox, publication, clusters, sources, ai, community, discussion, ingest, stories, topics, people, reading, auth, viewers, worker, indexnow };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'news', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'news', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;
    // Per-actor limits (http/actor-limits.js) on /api/v1, the desk and the comment form, counted once
    // each router resolved req.viewer; the per-address limits below stay.
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.limits = createActorLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, valkey });

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
                // openvibe.events: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.events'],
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
    const readiness = createNewsReadiness({ store, outbox, ingest, config, release: release.release, valkey: ctx.valkey });
    app.get('/api/ready', readiness.handler);
    // GET /<key>.txt — the IndexNow key file (only when a key is configured; it serves itself).
    if (indexnow.enabled) app.use(indexnow.keyFile);

    // ── Events webhook (raw body; before any other body parser) ─
    app.use(createEvents({ config, store, ingest, sources, log }));

    app.use(cookieParser());

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', auth.router(express));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'news', service: 'news', host: 'openvibe.news', name: 'OpenVibe.News' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
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
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
