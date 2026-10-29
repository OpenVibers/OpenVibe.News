'use strict';
// The Markdown twins of openvibe.news' public pages (openvibe-shared/agent-layer): the home, topics,
// the wire, live, AI briefs and stories. A twin is the page's own render: the public router answers the
// request in-process, signed out (no session cookie, no Authorization), so a twin cannot drift from the
// page a browser gets and never carries a signed-in person's editor controls or private cache.
//
// A retracted story keeps its twin (the page is still readable and labelled retracted); an unpublished
// or missing story, a missing topic or brief answers 404 and has no twin.
const TWIN_PATH_RE = /^\/(?:topics(?:\/[^/]+)?|wire|live|briefs(?:\/[^/]+)?|stories\/[^/]+)?$/;

/** A request as an anonymous browser makes it: no session, no cookies, no Authorization header. */
function anonymousRequest(url, path, query, host) {
    return {
        method: 'GET', url, originalUrl: url, path, params: {}, query,
        headers: { accept: 'text/html', host }, cookies: {}, body: undefined, protocol: 'https', secure: true,
        ip: '127.0.0.1', ips: ['127.0.0.1'], hostname: host,
        get(name) { return this.headers[String(name || '').toLowerCase()] || ''; },
        accepts(types) {
            if (!Array.isArray(types)) return 'text/html';
            return types.some((t) => t === 'html' || t === 'text/html') ? 'html' : false;
        },
        is() { return false; },
    };
}

/** A response that keeps what the page wrote, so the twin can be built from it. */
function captureResponse() {
    return {
        statusCode: 200, headers: {}, body: null, headersSent: false,
        status(code) { this.statusCode = code; return this; },
        set(name, value) { this.headers[String(name)] = value; return this; },
        setHeader(name, value) { this.headers[String(name)] = value; return this; },
        getHeader(name) { return this.headers[String(name)]; },
        get(name) { return this.headers[String(name)]; },
        removeHeader(name) { delete this.headers[String(name)]; },
        vary(field) {
            const prev = this.headers.Vary ? String(this.headers.Vary).split(',').map((s) => s.trim()) : [];
            for (const f of String(field || '').split(',').map((s) => s.trim()).filter(Boolean)) {
                if (!prev.some((p) => p.toLowerCase() === f.toLowerCase())) prev.push(f);
            }
            this.headers.Vary = prev.join(', ');
            return this;
        },
        type(value) { this.headers['Content-Type'] = value === 'html' ? 'text/html; charset=utf-8' : String(value); return this; },
        location(url) { this.headers.Location = url; return this; },
        send(body) { this.body = body; this.headersSent = true; return this; },
        json(body) { this.body = JSON.stringify(body); this.headersSent = true; return this; },
        redirect(code, url) { this.statusCode = code; this.headers.Location = url; this.body = ''; this.headersSent = true; return this; },
        end(body) { if (body !== undefined) this.body = body; this.headersSent = true; return this; },
        cookie() { return this; }, clearCookie() { return this; },
    };
}

function createAgentPages({ router, host }) {
    async function renderPublicPage(path, { query } = {}) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (!TWIN_PATH_RE.test(p)) return null;
        const search = query ? query.toString() : '';
        const url = search ? `${p}?${search}` : p;
        const req = anonymousRequest(url, p, Object.fromEntries(new URLSearchParams(search)), host);
        const res = captureResponse();
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            const send = res.send.bind(res);
            res.send = (body) => { send(body); finish(); return res; };
            const redirect = res.redirect.bind(res);
            res.redirect = (code, location) => { redirect(code, location); finish(); return res; };
            try { router(req, res, () => finish()); } catch { finish(); }
            const timer = setTimeout(finish, 10000);
            if (timer.unref) timer.unref();
        });
        // A page that is not public (an unpublished story, a missing topic or brief) has no twin.
        if (res.statusCode !== 200 || res.body == null) return null;
        const html = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
        if (!/^text\/html/i.test(String(res.headers['Content-Type'] || ''))) return null;
        return { html };
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages, TWIN_PATH_RE };
