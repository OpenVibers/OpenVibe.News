'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-publishing/layout (openvibe-shared/shell
 * page()) and is complete without JavaScript:
 *   - <head>: title, description, canonical and robots from the indexability gate's decision
 *     (there is no default that makes a page indexable), Open Graph/Twitter, JSON-LD, article
 *     times, prev/next, feed links, the shared app icon, the site stylesheet and the boost marker
 *   - the OpenVibe Frame: theme-loader, web runtime, navbar and footer from the Network
 *     (progressive), a <noscript> navigation bar and the server-rendered shared footer
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const layout = require('openvibe-publishing/layout');
const frame = require('openvibe-shared/frame');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.News';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// The product's own places: the main ones carry an icon (phones get them as the bottom tab bar), the rest fold
// into the navbar's More (Shared 4.22). Search is the navbar's magnifier; What shipped is the footer's.
const NAV_LINKS = [
    { label: 'News', href: '/', icon: 'fa-newspaper' },
    { label: 'Topics', href: '/topics', icon: 'fa-tag' },
    { label: 'Wire', href: '/wire', icon: 'fa-bolt' },
    { label: 'Live', href: '/live', icon: 'fa-tower-broadcast' },
    { label: 'AI briefs', href: '/briefs', icon: 'fa-brain' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, decision (required), canonical, type ('website'|'article'), image,
 *    jsonLd [], feeds [{ type, href, title }], body (HTML), viewer, config, csrf,
 *    published, modified, author, prev, next, bodyClass,
 *    summary, facts, updated, url (the shell's ai-summary inputs; openvibe-publishing v1.3.0),
 *    styles [openvibe-shared stylesheet names]
 */
function renderPage(o) {
    if (!o.decision) throw new TypeError('renderPage needs the gate decision');
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    // The path without its query: o.path is often the whole requested URL, and a sign-in link that echoed
    // the query would put the page's words into every page of the site (SEO-7 review, 2026-10-29).
    const loginNext = encodeURIComponent(String(o.path || '/').split('?')[0] || '/');
    const nav = {
        service: 'news',
        apiBase: NETWORK_URL,
        links: NAV_LINKS,
        appBar: true,   // phones: the five places as the bottom tab bar (Shared 4.20)
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,             // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    if (signedIn) nav.menu = { before: (o.editor ? [{ label: 'Editor desk', href: '/edit', icon: 'fa-pen' }] : []) };
    const footer = { service: 'news', variant: 'auto', path: o.path, mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };   // full on the front page only (Shared 4.19)
    const account = signedIn
        ? `${o.editor ? '<a href="/edit">Editor desk</a> · ' : ''}<a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    return layout.renderDocument({
        site: 'news',
        siteName: SITE_NAME,
        lang: o.lang,
        // The front page's title says what the site is (search results show it); every other page is "<page> · OpenVibe.News".
        title: o.title ? `${o.title} · ${SITE_NAME}` : o.path === '/' ? `${SITE_NAME}: source-backed news, every claim cited` : SITE_NAME,
        description: o.description || 'Source-backed news: every claim cites the reports it rests on.',
        canonical: o.canonical,
        decision: o.decision,
        // The shell builds the AI summary (seo.pageSummary): summary puts <meta name="ai-summary">
        // and a WebPage JSON-LD tag in <head>; facts/updated/url feed it. Nothing is invented.
        summary: o.summary,
        facts: o.facts,
        updated: o.updated,
        url: o.url,
        type: o.type || 'website',
        image: o.image,
        author: o.author,
        jsonLd: o.jsonLd,
        feeds: o.feeds,
        published: o.published,
        modified: o.modified,
        prev: o.prev,
        next: o.next,
        navbar: nav,
        footer,
        navLinks: NAV_LINKS,
        home: '/',
        css: asset('css/news.css'),
        styles: o.styles,   // openvibe-shared stylesheet names (the home page's showcase.css)
        // This service's own extra stylesheets for one kind of page (the briefs and live pages' css/briefs.css).
        head: (o.localStyles || []).map((rel) => `<link rel="stylesheet" href="${asset(rel)}">`).join('\n'),
        release: RELEASE,
        account,
        body: o.body,
        shipped: o.path === '/' ? frame.shipped({ service: 'news', title: `Recently shipped on ${SITE_NAME}` }) : '',
        bodyClass: o.bodyClass,
    });
}

module.exports = { renderPage, asset, assetVersion, setRelease, SITE_NAME, NETWORK_URL };
