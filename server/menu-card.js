'use strict';
// The menu's network card for OpenVibe.News (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
//
// News publishes "Top stories": the newest published stories readers can open, each linking to its story page.
// The rows come from the same public listing the home page uses (stories.listPublished + reading.listItems), so
// the card can only show what an anonymous reader can already read: drafts and retracted stories never appear.
// The file is public and CORS *, cached for five minutes (the card's ttl); Network fetches it every five minutes.
// With nothing published the card is still served, with no items, and Network skips it.
const BASE = 'https://openvibe.news';
const CARD_ID = 'top-stories';
const SITE = 'news';
const CARD_TTL_S = 300;
const CACHE_MS = CARD_TTL_S * 1000;
const LIMIT = 6;

/** Plain words for a card: no markup, no control characters, one line, within the schema's limit. */
function plain(value, max) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** "just now", "12m ago", "3h ago" or "2d ago" for a story's first publication; empty when unknown. */
function ago(value, now) {
    // first_published_at is epoch milliseconds (a bigint from the database), but a date string works too.
    const at = typeof value === 'number' ? value : Date.parse(String(value || ''));
    if (!Number.isFinite(at)) return '';
    const mins = Math.max(0, Math.floor((now - at) / 60_000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/** The card itself. `items` are reading.listItems() rows: { headline, url (path), outlets, published_at, retracted }. */
function cardFrom(items, at = Date.now()) {
    const out = [];
    for (const it of Array.isArray(items) ? items : []) {
        if (!it || it.retracted) continue;
        const title = plain(it.headline, 80);
        const path = String(it.url || '');
        if (!title || !path.startsWith('/')) continue;
        const meta = [plain((it.outlets || [])[0], 60), ago(it.published_at, at)].filter(Boolean).join(' · ');
        out.push({ title, ...(meta ? { meta: plain(meta, 120) } : {}), url: `${BASE}${path}` });
        if (out.length >= LIMIT) break;
    }
    return {
        id: CARD_ID,
        site: SITE,
        title: 'Top stories',
        kind: 'rows',
        items: out,
        more: { label: 'All stories', url: `${BASE}/` },
        updated_at: new Date(at).toISOString(),
        ttl_s: CARD_TTL_S,
    };
}

/** The route. `load` returns reading.listItems() rows; `now` is injectable for the test. */
function createMenuCard({ load, now = Date.now } = {}) {
    let cached = null;
    let cachedAt = 0;
    let pending = null;

    async function card() {
        const at = now();
        if (cached && at - cachedAt < CACHE_MS) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                cached = cardFrom(await load(), at);
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

module.exports = { createMenuCard, cardFrom, ago, plain, BASE, CARD_ID, SITE, CARD_TTL_S, LIMIT };
