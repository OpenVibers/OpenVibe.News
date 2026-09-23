'use strict';
/**
 * In-process stand-ins for News' neighbours, with a real RS256 key pair:
 *   Network    JWKS, /oauth/token (client_credentials → service tokens with the requested scope as
 *              capabilities), /internal/identity/resolve-batch (needs identity.subject.resolve)
 *   Sources    /api/v1/items (change order, category filter, include_removed), /api/v1/items/:id,
 *              /api/v1/sources/:key — items the test adds, revises and removes
 *   AI         /api/v1/runs — a canned run result the test sets
 * userToken()/serviceToken() mint the tokens browsers and services present to News;
 * delivery() signs an Events webhook delivery.
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                handler(req, raw, json, res);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
    });
}

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const directory = new Map();   // subject → { username, display_name }
    const grants = [];
    let issuer = null;
    const srv = await listen((req, raw, json) => {
        if (req.url === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
        if (req.url === '/oauth/token' && req.method === 'POST') {
            let body = {};
            if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
            else { try { body = JSON.parse(raw); } catch { /* */ } }
            grants.push(body);
            if (body.client_secret !== 'shh') return json(401, { error: 'invalid_client' });
            if (body.grant_type === 'client_credentials') {
                let scope = body.scope;
                if (scope && typeof scope === 'object') scope = Object.values(scope).join(' ');
                const cap = String(scope || '').split(/\s+/).filter(Boolean);
                return json(200, { access_token: signService({ sub: `svc:${body.client_id}`, aud: [body.audience || 'openvibe.events'], cap }), token_type: 'Bearer', expires_in: 300 });
            }
            return json(400, { error: 'unsupported_grant_type' });
        }
        if (req.url === '/internal/identity/resolve-batch' && req.method === 'POST') {
            const token = String(req.headers.authorization || '').slice(7);
            const v = serviceAuth.verifyServiceToken(token, { publicKey: publicPem, issuer, audience: 'openvibe.network' });
            if (!v.ok || !(v.claims.cap || []).includes('identity.subject.resolve')) return json(403, { code: 'capability.denied' });
            const b = JSON.parse(raw || '{}');
            const results = {};
            for (const s of b.subject_ids || []) {
                const u = directory.get(s);
                results[s] = u ? { subject: { type: 'user', id: s }, username: u.username, display_name: u.display_name, avatar_url: null, banned: false } : null;
            }
            return json(200, { results });
        }
        return json(404, { error: 'not found' });
    });
    issuer = srv.url;
    function signService({ sub, aud, cap, ns, actorType = 'service', extra = {} }) {
        return serviceAuth.signServiceToken({ iss: issuer, sub, actor_type: actorType, aud, cap, ...(ns ? { ns } : {}), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID(), ...extra }, privatePem);
    }
    function addUser(username, extra = {}) {
        const subject = ids.newId('user');
        const u = { subject, username, display_name: extra.display_name || username[0].toUpperCase() + username.slice(1), role: extra.role || 'user' };
        directory.set(subject, u);
        return u;
    }
    function userToken(u) {
        return jwt.sign({ sub: String(Math.floor(Math.random() * 1e6)), subject_id: u.subject, username: u.username, display_name: u.display_name, role: u.role || 'user' }, privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
    }
    function serviceToken(client, cap) {
        return signService({ sub: `svc:${client}`, aud: ['openvibe.news'], cap });
    }
    return { ...srv, publicPem, grants, directory, addUser, userToken, serviceToken, signService };
}


async function startSources({ network }) {
    const items = [];          // Sources item views
    const sources = new Map(); // key → registry record
    const calls = [];
    let down = false;
    let seq = 0;
    let n = 0;
    const srv = await listen((req, raw, json) => {
        calls.push({ method: req.method, url: req.url });
        if (down) return json(503, { code: 'down' });
        const token = String(req.headers.authorization || '').slice(7);
        const v = serviceAuth.verifyServiceToken(token, { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.sources' });
        const u = new URL(req.url, 'http://x');
        const need = u.pathname.startsWith('/api/v1/sources') ? 'sources.source.read' : 'sources.item.read';
        if (!v.ok || !(v.claims.cap || []).includes(need)) return json(403, { code: 'capability.denied' });
        if (u.pathname === '/api/v1/items') {
            const after = Number(u.searchParams.get('after') || 0);
            const limit = Number(u.searchParams.get('limit') || 100);
            const cat = u.searchParams.get('category');
            const incl = u.searchParams.get('include_removed') === '1';
            const rows = items.filter((i) => i.change_seq > after && (!cat || i.category === cat) && (incl || !i.removed)).sort((a, b) => a.change_seq - b.change_seq);
            const page = rows.slice(0, limit);
            const status = {};
            for (const i of page) status[i.source_key] = { status: 'healthy', stale: false, last_success_at: '2026-09-22T11:00:00.000Z' };
            return json(200, { items: page, next_after: page.length ? page[page.length - 1].change_seq : after, more: rows.length > limit, sources: status });
        }
        let m = u.pathname.match(/^\/api\/v1\/items\/([A-Za-z0-9_]+)$/);
        if (m) {
            const it = items.find((i) => i.id === m[1]);
            if (!it) return json(404, { code: 'sources.not_found' });
            return json(200, { item: it, source: { key: it.source_key, status: 'healthy', stale: false, last_success_at: '2026-09-22T11:00:00.000Z' } });
        }
        m = u.pathname.match(/^\/api\/v1\/sources\/([a-z0-9-]+)$/);
        if (m) {
            const s = sources.get(m[1]);
            if (!s) return json(404, { code: 'sources.not_found' });
            return json(200, { source: s });
        }
        return json(404, { code: 'route.not_found' });
    });
    const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const newId = () => { n++; let s = String(n); while (s.length < 26) s = `0${s}`; return `itm_${s.replace(/[^0-9]/g, '0')}`; };
    function addSource(key, extra = {}) {
        sources.set(key, { key, name: extra.name || key, homepage_url: extra.homepage_url || null, category: extra.category || 'news', health: { status: 'healthy', stale: false, last_success_at: '2026-09-22T11:00:00.000Z' } });
    }
    /** Add an item as Sources' ingest would. fields: title, url, summary, authors, published_at, source_key, terms_note, license_note, category, fields */
    function addItem(f = {}) {
        const it = {
            id: newId(), source_key: f.source_key || 'wire-a', category: f.category || 'news', kind: f.kind || 'article', identity: f.url || `id-${n}`,
            canonical_url: f.url === undefined ? `https://example.org/a/${n}` : f.url, title: f.title === undefined ? `Item ${n}` : f.title, summary: f.summary || null,
            authors: f.authors || [], published_at: f.published_at || null, source_updated_at: null, fields: f.fields || {},
            revision: 1,
            provenance: {
                retrieved_at: f.retrieved_at || '2026-09-22T11:00:00.000Z', first_seen_at: '2026-09-22T11:00:00.000Z',
                content_hash: f.content_hash || require('crypto').createHash('sha256').update(`${n}:${f.title}:${f.url}`).digest('hex'),
                raw_body_hash: 'x', parser_version: 'feed@1', fetch_run_id: 'run_1',
                license_note: f.license_note === undefined ? null : f.license_note,
                terms_note: f.terms_note === undefined ? 'Titles, links and short summaries only; link back.' : f.terms_note, entered_by: null,
            },
            removed: null, change_seq: ++seq,
        };
        items.push(it);
        return it;
    }
    function updateItem(id, f = {}) {
        const it = items.find((i) => i.id === id);
        if (f.title !== undefined) it.title = f.title;
        if (f.summary !== undefined) it.summary = f.summary;
        if (f.published_at !== undefined) it.published_at = f.published_at;
        it.provenance.content_hash = require('crypto').createHash('sha256').update(`${id}:${it.title}:${it.revision + 1}`).digest('hex');
        it.revision++;
        it.change_seq = ++seq;
        return it;
    }
    function removeItem(id, reason) {
        const it = items.find((i) => i.id === id);
        it.removed = { at: '2026-09-22T12:30:00.000Z', reason };
        it.revision++;
        it.change_seq = ++seq;
        return it;
    }
    void ULID;
    return { ...srv, items, calls, addSource, addItem, updateItem, removeItem, setDown: (v) => { down = v; } };
}

async function startAi({ network }) {
    let next = null;   // { status, run } the next POST /api/v1/runs answers with
    const requests = [];
    const srv = await listen((req, raw, json) => {
        const token = String(req.headers.authorization || '').slice(7);
        const v = serviceAuth.verifyServiceToken(token, { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.ai' });
        if (!v.ok || !(v.claims.cap || []).includes('ai.run.create')) return json(403, { code: 'capability.denied' });
        if (req.url.startsWith('/api/v1/runs') && req.method === 'POST') {
            requests.push(JSON.parse(raw || '{}'));
            if (!next) return json(503, { code: 'ai.unavailable' });
            return json(next.status || 201, { run: next.run });
        }
        return json(404, { code: 'route.not_found' });
    });
    return { ...srv, requests, setNext: (v) => { next = v; } };
}

/**
 * An Events webhook delivery for News: { body, headers } signed with the secret (v1 and v2, as
 * Events sends it). `v1Only` leaves the v2 headers off; `now` (ms) backdates the v2 timestamp.
 */
function delivery(event, secret, { seq = 1, attempt = 1, v1Only = false, now = Date.now() } = {}) {
    const envelope = { event_id: `evt_${ids.ulid(Date.now())}`, version: 1, timestamp: new Date().toISOString(), visibility: 'internal', actor: { type: 'service', id: 'sources' }, source: 'sources', payload: {}, ...event };
    const body = JSON.stringify({ event: envelope, seq });
    const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    const ts = Math.floor(now / 1000);
    const v2 = v1Only ? {} : { 'x-openvibe-timestamp': String(ts), 'x-openvibe-signature-v2': `t=${ts},v2=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}` };
    return { body, envelope, headers: { 'content-type': 'application/json', 'x-openvibe-signature': sig, ...v2, 'x-openvibe-delivery-attempt': String(attempt), 'x-openvibe-seq': String(seq) } };
}

module.exports = { startNetwork, startSources, startAi, delivery, listen };
