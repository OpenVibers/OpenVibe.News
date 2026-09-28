'use strict';
/**
 * Per-actor rate limits on /api/v1, the editor desk and the comment form (roadmap WS-R task 4;
 * openvibe-sdk/limits).
 *
 * The per-address limits in app.js (/auth, /api/v1, /edit, /clusters, the comment form) stay. These
 * count requests by who makes them, once req.viewer is resolved (auth/viewer.js) and a route's
 * capability guard passed:
 *
 *   a person                         user:usr_… (their own token or cookie, a first-party service naming
 *                                    them in X-OV-Subject, or an app's on_behalf_of)
 *   a service or app acting as       its principal (svc:ai, app:app_…)
 *     itself
 *   anyone else                      ip:<address>
 *
 * Reads: a signed-in person's or an app's GET/HEAD under /api/v1 takes NEWS_LIMITS_MINUTE /
 * NEWS_LIMITS_HOUR (120 and 3000), and so does an editor's desk page. Signed-out reads keep only the
 * per-address limit (many readers share a carrier or campus address), and a first-party service
 * reading for itself is not counted on reads (the per-address /api/v1 limit bounds it). Every write
 * has its own budget below, shared by the API route and the desk form that do the same thing. Past a
 * limit the route answers 429 problem+json `rate_limited` with Retry-After before any work; the refusal
 * is logged once and counted in news_rate_limited_total{limit,window}. Counters live in this process:
 * a restart forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, sign-in, the public pages and feeds
 * (nginx and the per-address limits bound them), and the signed Events deliveries at /internal/events.
 */
const { createActorLimiter, defaultActor } = require('openvibe-sdk/limits');

const FIRST_PARTY = /^svc:/;

function actor(req) {
    const v = req.viewer;
    if (!v || v.kind === 'anonymous') return defaultActor(req);
    if (v.subject) return `user:${v.subject}`;
    if (v.kind === 'service' && v.service) return v.service;
    if (v.kind === 'user' && v.user && v.user.id != null) return `user:${v.user.id}`;
    return defaultActor(req);
}

/** Counted on reads: a signed-in person, or a service or app acting for a person or as a third party. */
function countedRead(req) {
    const v = req.viewer;
    if (!v || v.kind === 'anonymous') return false;
    if (v.kind === 'service' && !v.subject && FIRST_PARTY.test(String(v.service))) return false;
    return true;
}

/**
 * The writes and expensive reads, each with its numbers per caller (a minute, an hour). A desk form
 * and the API route that do the same thing share one budget.
 */
const BUDGETS = {
    // A topic is a new section with its own page and feeds: an editor adds a few.
    'news.topic.manage': { minute: 10, hour: 60 },
    // A new story stores its first text and emits news.story.created; a revision stores the whole
    // text again and checks every citation. An editor saves every few seconds at most: 30 a minute,
    // 300 new stories or 600 revisions an hour.
    'news.story.create': { minute: 30, hour: 300 },
    'news.story.revise': { minute: 30, hour: 600 },
    // An AI draft asks OpenVibe.AI to summarize or compare every source (up to NEWS_AI_WAIT_MS each):
    // a few a minute.
    'news.story.ai_draft': { minute: 5, hour: 60 },
    // Publishing, unpublishing, retracting and reviews change what readers, feeds, sitemaps and
    // Search see, and emit an event each.
    'news.story.publish': { minute: 30, hour: 300 },
    // Attaching a source looks the item up in OpenVibe.Sources.
    'news.source.attach': { minute: 30, hour: 300 },
    // Perspectives, timeline entries and editorial flags: small edits, a few in a row.
    'news.story.annotate': { minute: 60, hour: 600 },
    // Merge, split and reverse rewrite a cluster's membership and its audit.
    'news.cluster.manage': { minute: 30, hour: 300 },
    // A pull reads up to NEWS_PULL_MAX_PAGES pages of Sources items and clusters them: the worker
    // already pulls on a schedule, so a person's button is a rare nudge.
    'news.ingest.pull': { minute: 2, hour: 20 },
    // A comment goes to OpenVibe.Community in the person's name (Community allows 20 a minute).
    'news.discussion.comment': { minute: 20, hour: 300 },
    // A word diff of two long revisions costs hundreds of ms of CPU: a person's pace.
    'news.story.diff': { minute: 30, hour: 600 },
};

/**
 * limits(name, own) middleware for one app, plus limits.reads(name) (the defaults on a counted
 * GET/HEAD) and limits.budget(name) (one of BUDGETS).
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console }) {
    const refused = registry
        ? registry.counter({ name: 'news_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor,
        now,
        onLimited(e) {
            // The actor is a subject id, a principal or an address, never a token.
            log.warn(`[News] limit ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && countedRead(req) ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    /** A budget on an expensive read, counted like limits.reads (signed-out reads keep the per-address limit). */
    limiter.readBudget = (name) => {
        const m = limiter.budget(name);
        return (req, res, next) => (countedRead(req) ? m(req, res, next) : next());
    };
    /** A budget counted only for a signed-in person (a signed-out form post is sent to sign in, no work). */
    limiter.signedIn = (name) => {
        const m = limiter.budget(name);
        return (req, res, next) => (req.viewer && req.viewer.kind === 'user' ? m(req, res, next) : next());
    };
    return limiter;
}

module.exports = { createActorLimits, actor, countedRead, BUDGETS };
