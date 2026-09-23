'use strict';

/**
 * OpenVibe.Sources client (host-local API, service tokens for audience openvibe.sources).
 *
 *   sources.item.read     GET /api/v1/items?category=news&after=&limit=&include_removed=1   (change order)
 *                         GET /api/v1/items/:id
 *   sources.source.read   GET /api/v1/sources/:key   (optional: outlet names and source health)
 *
 * Failures are thrown as errors with a stable `code` (sources.unavailable, sources.http_<status>,
 * sources.bad_response); the caller records them. Nothing here invents an item.
 */
const { serviceAuth } = require('openvibe-contracts');

class SourcesError extends Error {
    constructor(code, message, status = null) { super(message); this.code = code; this.status = status; }
}

function createSourcesClient({ config, fetchImpl = globalThis.fetch }) {
    const enabled = Boolean(config.oauth.clientSecret && config.sources.internalUrl);
    const token = (scope) => (enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.sources', scope, fetchImpl,
    }) : null);
    const itemTokens = token('sources.item.read');
    const sourceTokens = token('sources.source.read');

    async function call(tokens, path) {
        if (!tokens) throw new SourcesError('sources.not_configured', 'OV_OAUTH_CLIENT_SECRET or OV_SOURCES_INTERNAL_URL is not set');
        let auth;
        try { auth = await tokens.authHeaders(); } catch (err) {
            throw new SourcesError('sources.token_unavailable', `No service token for OpenVibe.Sources: ${err.message}`);
        }
        let res;
        try {
            res = await fetchImpl(`${config.sources.internalUrl}${path}`, {
                headers: { Accept: 'application/json', ...auth },
                signal: AbortSignal.timeout(config.sources.timeoutMs),
            });
        } catch (err) {
            throw new SourcesError('sources.unavailable', `OpenVibe.Sources is unreachable: ${err.message}`);
        }
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new SourcesError(`sources.http_${res.status}`, `OpenVibe.Sources answered ${res.status}${body && (body.code || body.detail) ? `: ${body.code || ''} ${body.detail || ''}`.trimEnd() : ''}`, res.status);
        if (!body || typeof body !== 'object') throw new SourcesError('sources.bad_response', 'OpenVibe.Sources sent no JSON');
        return body;
    }

    return {
        enabled,
        SourcesError,

        /** One page of news items in change order. → { items, next_after, more, sources } */
        async listItems({ after = 0, limit = 100 } = {}) {
            const qs = new URLSearchParams({ category: config.sources.category, after: String(after), limit: String(limit), include_removed: '1' });
            const body = await call(itemTokens, `/api/v1/items?${qs}`);
            if (!Array.isArray(body.items) || !Number.isInteger(body.next_after)) throw new SourcesError('sources.bad_response', 'items page without items/next_after');
            return body;
        },

        /** One item (with its source's health). → { item, source } */
        async getItem(id) {
            const body = await call(itemTokens, `/api/v1/items/${encodeURIComponent(id)}`);
            if (!body.item || typeof body.item.id !== 'string') throw new SourcesError('sources.bad_response', 'item response without item');
            return body;
        },

        /** A registry record (name, homepage, health). Needs sources.source.read; callers treat failure as "unknown". */
        async getSource(key) {
            const body = await call(sourceTokens, `/api/v1/sources/${encodeURIComponent(key)}`);
            return body.source || body;
        },
    };
}

module.exports = { createSourcesClient, SourcesError };
