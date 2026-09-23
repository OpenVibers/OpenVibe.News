'use strict';
/**
 * Boots News on a temp database with a controllable clock and mocks of its neighbours, and returns
 * a small HTTP client. Every test file gets its own instance.
 *
 *   const t = await boot();                  // t.base, t.get(path, { as: user | token, form, json })
 *   t.editor                                 // a Network user listed in NEWS_EDITORS
 *   t.sources.addItem({...}); await t.pull() // Sources items → News
 *   t.deliver(event)                         // a signed Events webhook delivery
 *   t.clock.advance(ms)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startNetwork, startSources, startAi, delivery } = require('./mocks');

const SECRET = 'test-webhook-secret-0123456789abcdef0123';

function makeClock(start = Date.parse('2026-09-22T12:00:00Z')) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; return t; }, set: (v) => { t = v; } };
}

async function boot(opts = {}) {
    const network = await startNetwork();
    const sources = await startSources({ network });
    const ai = await startAi({ network });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-news-test-'));
    const dbPath = path.join(dir, 'news.db');
    const clock = opts.clock || makeClock();
    const editor = network.addUser('ed', { display_name: 'Edie Editor' });
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.news', TRUST_PROXY: '1',
        NEWS_DB_PATH: dbPath,
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'news', OV_OAUTH_CLIENT_SECRET: 'shh', COOKIE_SECURE: 'false',
        OV_SOURCES_INTERNAL_URL: sources.url,
        NEWS_EDITORS: editor.subject, NEWS_WORKER: 'off', NEWS_FORM_SECRET: 'test-form-secret',
        NEWS_EVENTS_SECRET: SECRET,
        ...(opts.ai ? { OV_AI_INTERNAL_URL: ai.url } : {}),
        ...(opts.env || {}),
    };
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const quiet = { log() {}, warn() {}, error: (...a) => { if (process.env.VERBOSE) console.error(...a); } };

    let server = null;
    let built = null;
    async function start() {
        const config = configLib.load(env);
        built = createApp({ config, now: clock.now, log: quiet });
        await built.ctx.auth.ensureKey();
        server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        t.base = `http://127.0.0.1:${server.address().port}`;
        t.app = built.app;
        t.ctx = built.ctx;
    }
    async function stop() {
        if (server) await new Promise((r) => server.close(r));
        if (built) { built.ctx.worker.stop(); await built.ctx.outbox.stop(); built.ctx.store.close(); }
        server = null; built = null;
    }

    /** as: a network user ({ subject, … }) → ov_token cookie; a string → Bearer token. */
    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as && typeof o.as === 'object') headers.cookie = `ov_token=${network.userToken(o.as)}`;
        if (typeof o.as === 'string') headers.authorization = `Bearer ${o.as}`;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) { body = new URLSearchParams(o.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        const res = await fetch(t.base + p, { method: o.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text, json() { return JSON.parse(text); } };
    }

    /** Rows of event_outbox as parsed envelopes. */
    function events(type = null) {
        return t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope)).filter((e) => !type || e.event_type === type || (type instanceof RegExp && type.test(e.event_type)));
    }

    async function deliver(event, o = {}) {
        const d = delivery(event, o.secret || SECRET, o);
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', headers: d.headers, body: d.body });
        return { status: res.status, text: await res.text(), envelope: d.envelope, body: d.body, headers: d.headers };
    }

    /** API call as the editor (browser JWT). */
    const api = (p, o = {}) => get(`/api/v1${p}`, { as: editor, ...o });

    const t = {
        network, sources, ai, clock, dbPath, editor, get, api, events, deliver, SECRET,
        pull: () => t.ctx.ingest.pull(),
        db: () => t.ctx.store.db,
        csrf: (user) => require('../../server/auth/forms').csrfToken({ formSecret: env.NEWS_FORM_SECRET }, user),
        async restart() { await stop(); await start(); },
        async close() { await stop(); await network.close(); await sources.close(); await ai.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
    await start();
    return t;
}

/** A cluster-ready set: three reports of one event from three outlets, all in the news category. */
function launchReports(sources, extra = {}) {
    sources.addSource('wire-a', { name: 'Wire A' });
    sources.addSource('paper-b', { name: 'Paper B' });
    sources.addSource('site-c', { name: 'Site C' });
    const a = sources.addItem({ source_key: 'wire-a', title: 'NASA launches Europa Clipper probe to Jupiter moon Europa', url: 'https://wire-a.example/space/europa-clipper-launch', summary: 'The Europa Clipper spacecraft lifted off on a Falcon Heavy rocket from Kennedy Space Center.', authors: ['Ana Reporter'], published_at: '2026-09-22T09:00:00Z', ...(extra.a || {}) });
    const b = sources.addItem({ source_key: 'paper-b', title: 'Europa Clipper lifts off as NASA begins long trip to Jupiter', url: 'https://paper-b.example/2026/09/22/europa-clipper', summary: 'NASA said the Europa Clipper mission will reach Jupiter in 2030.', authors: ['Ben Writer'], published_at: '2026-09-22T09:30:00Z', ...(extra.b || {}) });
    const c = sources.addItem({ source_key: 'site-c', title: 'Why NASA is sending Europa Clipper to Jupiter', url: 'https://site-c.example/europa-clipper-why', summary: null, authors: [], published_at: '2026-09-22T10:00:00Z', ...(extra.c || {}) });
    return { a, b, c };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, makeClock, launchReports, SECRET };
