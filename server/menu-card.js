'use strict';
// The menu's network card for OpenVibe.News (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
//
// News publishes "Top stories": the published stories first published today (UTC), newest first, each linking to
// its story page. When nothing was published today the card falls back to the newest published stories of any
// age and says so: "Latest stories". The rows come from the same public listing the home page uses
// (stories.listPublished + reading.listItems), so the card can only show what an anonymous reader can already
// read: drafts, unpublished and private stories, and retracted stories never appear.
// The file is public and CORS *, cached for five minutes (the card's ttl); Network fetches it every five minutes.
// With no published story at all (11-07: none yet), the card is "Latest AI briefs": OpenVibe.AI's source-linked briefs,
// each row saying it is one and how many reports it rests on, the same briefs the home shows. Only with neither is the
// card served empty, and Network skips it.
const BASE = 'https://openvibe.news';
const CARD_ID = 'top-stories';
const SITE = 'news';
const CARD_TTL_S = 300;
const CACHE_MS = CARD_TTL_S * 1000;
const LIMIT = 5;
const DAY = 24 * 60 * 60_000;

/** Plain words for a card: no markup, no control characters, one line, within the schema's limit. */
function plain(value, max) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** A publication instant in epoch ms: first_published_at is epoch milliseconds (int8 → Number), ISO works too. */
function instantOf(value) {
    const at = typeof value === 'number' ? value : Date.parse(String(value || ''));
    return Number.isFinite(at) ? at : NaN;
}

/** The UTC day a build time falls in starts here. "Today" is UTC, as on the rest of the network. */
function startOfDay(value) {
    const at = instantOf(value);
    return Number.isFinite(at) ? Date.parse(`${new Date(at).toISOString().slice(0, 10)}T00:00:00.000Z`) : NaN;
}

/** "just now", "12m ago", "3h ago" or "2d ago" for a story's first publication; empty when unknown. */
function ago(value, now) {
    const at = instantOf(value);
    if (!Number.isFinite(at)) return '';
    const mins = Math.max(0, Math.floor((now - at) / 60_000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The card itself. `items` are reading.listItems() rows: { headline, url (path), outlets, published_at,
 * retracted }. The newest published story wins; a story first published today (UTC) is a top story, and
 * when there is none the card is the latest stories of any age — the title says which it is.
 */
function cardFrom(items, at = Date.now()) {
    const since = startOfDay(at);
    const valid = [];
    for (const it of Array.isArray(items) ? items : []) {
        if (!it || it.retracted) continue;
        const title = plain(it.headline, 80);
        const path = String(it.url || '');
        if (!title || !path.startsWith('/')) continue;
        const published = instantOf(it.published_at);
        valid.push({
            it, title, path, published,
            top: Number.isFinite(since) && Number.isFinite(published) && published >= since && published < since + DAY,
        });
    }
    // The public listing is newest-first already; sort here too so the fallback is the newest by first publication.
    valid.sort((a, b) => ((Number.isFinite(b.published) ? b.published : 0) - (Number.isFinite(a.published) ? a.published : 0)) || (a.path < b.path ? -1 : 1));
    const top = valid.filter((v) => v.top);
    const chosen = (top.length ? top : valid).slice(0, LIMIT);
    const out = chosen.map(({ it, title, path }) => {
        const outlets = Array.isArray(it.outlets) ? it.outlets : [];
        const meta = [plain(outlets[0], 60), ago(it.published_at, at)].filter(Boolean).join(' · ');
        return { title, ...(meta ? { meta: plain(meta, 120) } : {}), url: `${BASE}${path}` };
    });
    return {
        id: CARD_ID,
        site: SITE,
        title: top.length ? 'Top stories' : 'Latest stories',
        kind: 'rows',
        items: out,
        more: { label: 'All stories', url: `${BASE}/` },
        updated_at: new Date(at).toISOString(),
        ttl_s: CARD_TTL_S,
    };
}

/**
 * The card when no story is published: the newest AI briefs (briefs.latest(), summaries only, no stub, with text),
 * each linking to its /briefs/:cluster_id page, its meta saying it is an AI brief and how many reports it rests on.
 */
function cardFromBriefs(briefs, at = Date.now()) {
    const out = [];
    for (const b of Array.isArray(briefs) ? briefs : []) {
        if (!b || b.kind !== 'summary' || b.stub || !Array.isArray(b.paragraphs) || !b.paragraphs.length) continue;
        const title = plain(b.headline || b.label, 80);
        const id = String(b.cluster_id || '');
        if (!title || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue;
        const reports = Number(b.item_count) || 0;
        const meta = ['AI brief', reports ? `${reports} ${reports === 1 ? 'report' : 'reports'}` : '', ago(b.window_end, at)].filter(Boolean).join(' · ');
        out.push({ title, meta: plain(meta, 120), url: `${BASE}/briefs/${id}` });
        if (out.length >= LIMIT) break;
    }
    return {
        id: CARD_ID,
        site: SITE,
        title: 'Latest AI briefs',
        kind: 'rows',
        items: out,
        more: { label: 'All AI briefs', url: `${BASE}/briefs` },
        updated_at: new Date(at).toISOString(),
        ttl_s: CARD_TTL_S,
    };
}

/**
 * The route. `load(at)` returns reading.listItems() rows; `loadBriefs(at)` (optional) returns briefs.latest() rows
 * for when no story is published; `now` is injectable for the test.
 */
function createMenuCard({ load, loadBriefs = null, now = Date.now } = {}) {
    let cached = null;
    let cachedAt = 0;
    let pending = null;

    async function card() {
        const at = now();
        if (cached && at - cachedAt < CACHE_MS) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                let next = cardFrom(await load(at), at);
                if (!next.items.length && loadBriefs) next = cardFromBriefs(await loadBriefs(at), at);
                cached = next;
                cachedAt = at;
            } catch {
                // Keep the last good card rather than publish an empty one on a database hiccup.
                if (!cached) { cached = cardFrom([], at); cachedAt = at; }
            }
            return cached;
        })().finally(() => { pending = null; });
        return pending;
    }

    async function handler(_req, res) {
        const body = await card();
        res.set('Cache-Control', 'public, max-age=60')
            .set('Access-Control-Allow-Origin', '*')
            .set('Cross-Origin-Resource-Policy', 'cross-origin')
            .json([body]);
    }

    return { card, handler, cardFrom, cacheMs: CACHE_MS };
}

module.exports = { createMenuCard, cardFrom, cardFromBriefs, startOfDay, ago, plain, BASE, CARD_ID, SITE, CARD_TTL_S, DAY, LIMIT };
