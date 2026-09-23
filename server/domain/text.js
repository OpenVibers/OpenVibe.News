'use strict';

/**
 * Deterministic text helpers for ingestion: URL keys and title keys for dedupe, word shingles for
 * near-duplicate headlines, the terms and named entities clustering compares, and the licensing
 * rule for source summaries. Pure functions: the same input always gives the same output, so every
 * dedupe and cluster decision can be recomputed and explained.
 */

const STOPWORDS = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by '
    + 'can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its '
    + 'itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the '
    + 'their theirs them then there these they this those through to too under until up very was we were what when where which while who whom '
    + 'why will with would you your yours says said say new news report reports update updates live latest via amid over after more first year '
    + 'years today yesterday week one two three four five six seven eight nine ten'
).split(/\s+/));

// Capitalised words that start sentences or headlines far more often than they name something.
const NOT_ENTITIES = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'as', 'how', 'why', 'what', 'when', 'where', 'who', 'new', 'breaking', 'update', 'live', 'watch', 'exclusive', 'opinion', 'analysis', 'report']);

/** Lowercase, strip accents and punctuation, collapse spaces. */
function fold(s) {
    return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A headline normalised for comparison. */
function titleKey(title) { return fold(title); }

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid|igshid|smid)$/i;

/**
 * The URL key dedupe compares: https, lowercase host without "www.", no fragment, no tracking
 * parameters, remaining parameters sorted, no trailing slash. null for anything that is not http(s).
 */
function urlKey(url) {
    if (!url) return null;
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
    const q = params.length ? `?${new URLSearchParams(params).toString()}` : '';
    let p = u.pathname.replace(/\/{2,}/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return `https://${host}${u.port && u.port !== '443' && u.port !== '80' ? `:${u.port}` : ''}${p}${q}`;
}

/** The outlet shown when the registry has no name: the URL's host without "www.". */
function hostOf(url) {
    try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/** Very light stemming: plural and possessive endings, so "rockets" and "rocket" meet. */
function stem(w) {
    if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
    return w;
}

/** Content terms of a text: folded words of 3+ letters (or any number), minus stopwords, stemmed, unique, sorted. */
function terms(text) {
    const out = new Set();
    for (const w of fold(text).split(' ')) {
        if (!w || STOPWORDS.has(w)) continue;
        if (w.length < 3 && !/^\d+$/.test(w)) continue;
        out.add(stem(w));
    }
    return [...out].sort();
}

/**
 * Named entities, deterministically: runs of Capitalised words (and ALL-CAPS acronyms of 2+
 * letters) in the original text, folded. A single capitalised word at the very start of the text
 * counts only if it is an acronym or appears capitalised again later. Sorted, unique.
 */
function entities(text) {
    const src = String(text || '');
    const tokens = src.split(/\s+/).filter(Boolean);
    const out = new Set();
    let run = [];
    const flush = () => {
        if (run.length) {
            const words = run.map((r) => r.word);
            const startsText = run[0].index === 0;
            const acronym = words.some((w) => /^[A-Z0-9]{2,}$/.test(w));
            if (!(startsText && words.length === 1 && !acronym && !laterCapitalised(words[0], run[0].index))) {
                const f = fold(words.join(' '));
                if (f && !NOT_ENTITIES.has(f) && !STOPWORDS.has(f)) out.add(f);
            }
        }
        run = [];
    };
    const laterCapitalised = (w, idx) => tokens.slice(idx + 1).some((t) => t.replace(/[^\p{L}\p{N}]/gu, '') === w);
    tokens.forEach((raw, index) => {
        const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        const cap = /^\p{Lu}/u.test(word) && !NOT_ENTITIES.has(word.toLowerCase());
        if (word && cap) run.push({ word, index }); else flush();
        if (/[.!?:;,]$/.test(raw)) flush();
    });
    flush();
    return [...out].sort();
}

/** Word 2-shingles of a folded headline (single-word headlines give the word itself). */
function shingles(title) {
    const w = titleKey(title).split(' ').filter(Boolean);
    if (w.length < 2) return new Set(w);
    const s = new Set();
    for (let i = 0; i < w.length - 1; i++) s.add(`${w[i]} ${w[i + 1]}`);
    return s;
}

function jaccard(a, b) {
    if (!a.size && !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

// ── Licensing ─────────────────────────────────────────────────

const ALLOWS_SUMMARY = /\b(short|brief)\s+summar(y|ies)\b|\bsummar(y|ies)\s+(are|is)\s+(allowed|permitted)\b/i;
const FORBIDS_SUMMARY = /\b(no|not|never|without)\s+(short\s+|brief\s+)?summar(y|ies)\b|\bsummar(y|ies)\s+(are|is)\s+not\b|\bheadlines?\s+(and\s+links\s+)?only\b|\btitles?\s+and\s+links\s+only\b/i;

/**
 * What of a source's summary News may keep: a short summary, only when the item's terms or licence
 * note explicitly allows short summaries (and nothing forbids them), cut to maxChars at a word
 * boundary. Article bodies are never kept, whatever the terms say. → { summary, basis }
 */
function licensedSummary(summary, { termsNote, licenseNote, maxChars = 280 } = {}) {
    const notes = `${termsNote || ''}\n${licenseNote || ''}`;
    const text = String(summary || '').replace(/\s+/g, ' ').trim();
    if (!text) return { summary: null, basis: 'none_provided' };
    if (!maxChars) return { summary: null, basis: 'summaries_disabled' };
    if (FORBIDS_SUMMARY.test(notes)) return { summary: null, basis: 'terms_forbid_summaries' };
    if (!ALLOWS_SUMMARY.test(notes)) return { summary: null, basis: 'terms_do_not_allow_summaries' };
    if (text.length <= maxChars) return { summary: text, basis: 'terms_allow_short_summaries' };
    const cut = text.slice(0, maxChars - 1);
    const at = cut.lastIndexOf(' ');
    return { summary: `${(at > maxChars * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`, basis: 'terms_allow_short_summaries' };
}

module.exports = { fold, titleKey, urlKey, hostOf, terms, entities, shingles, jaccard, licensedSummary, stem, STOPWORDS };
