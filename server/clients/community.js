'use strict';

/**
 * Comments are OpenVibe.Community threads, referenced — never copied. A story's thread is the one
 * Community resolves for EntityRef { service: 'news', type: 'story', id } (openvibe-publishing/
 * discussion stores only the thread id, in news_story_discussion_refs). Pages read the thread from
 * Community on render, so moderation and deletion there are always what readers see; a failure is
 * shown as "comments are unavailable", never as an empty or invented thread.
 *
 * Which stories may have an open thread is domain/discussion.js' rule; this client only talks to
 * Community.
 *
 * Calls with News' service token (audience openvibe.community):
 *   community.comment.write     resolve a thread; comment as the signed-in member (X-OV-Subject)
 *   community.comment.moderate  hide the thread of a story that was retracted, unpublished or rests
 *                               on a removed source; show it again when the story is open again
 */
const { serviceAuth, http } = require('openvibe-contracts');
const { createDiscussionClient } = require('openvibe-publishing/discussion');

function createCommunity({ store, config, fetchImpl = globalThis.fetch, log = console }) {
    const base = config.community.internalUrl;
    const enabled = Boolean(config.oauth.clientSecret && base);
    const tokenClient = (scope) => serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.community', scope, fetchImpl,
    });
    const writeTokens = enabled ? tokenClient('community.comment.write') : null;
    const modTokens = enabled ? tokenClient('community.comment.moderate') : null;
    const discussion = enabled ? createDiscussionClient({ communityUrl: base, tokenClient: writeTokens, fetchImpl }) : null;

    const refFor = (story, label) => ({ service: 'news', type: 'story', id: story.id, ...(label ? { label: String(label).slice(0, 200) } : {}) });

    async function call(method, path, { tokens, subject, body, ctx, timeoutMs = 4000 } = {}) {
        const headers = { Accept: 'application/json', ...(ctx ? http.outboundHeaders(ctx) : {}) };
        if (tokens) Object.assign(headers, await tokens.authHeaders());
        if (subject) headers['X-OV-Subject'] = subject;
        if (body) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
        const data = await res.json().catch(() => null);
        if (res.status === 401 && tokens && tokens.invalidate) tokens.invalidate();
        if (!res.ok) {
            const err = new Error((data && (data.detail || data.error)) || `Community answered ${res.status}`);
            err.status = res.status;
            err.code = data && data.code;
            throw err;
        }
        return data;
    }

    return {
        enabled,
        publicUrl: config.community.publicUrl,

        /** The stored thread id, or resolve it once through Community (the caller checks the story may have one). */
        async threadFor(story, label, ctx) {
            const known = store.discussion.get(story.id);
            if (known) return known.threadId;
            if (!discussion) return null;
            const out = await store.discussion.threadFor(story.id, refFor(story, label), { client: discussion, traceparent: ctx && ctx.traceparent, requestId: ctx && ctx.requestId });
            return out.threadId;
        },

        /** { thread, comments, next_cursor } read as an anonymous visitor (public data only). */
        async readThread(threadId, { after, ctx } = {}) {
            const qs = after ? `?after=${encodeURIComponent(after)}` : '';
            return call('GET', `/api/v1/comments/threads/${encodeURIComponent(threadId)}${qs}`, { ctx });
        },

        /** Comment as the signed-in member. */
        async comment(threadId, subject, { message, parentId } = {}, ctx) {
            if (!writeTokens) { const e = new Error('comments are not configured'); e.status = 503; throw e; }
            return call('POST', `/api/v1/comments/threads/${encodeURIComponent(threadId)}/comments`, {
                tokens: writeTokens, subject, body: { message, ...(parentId ? { parent_id: parentId } : {}) }, ctx,
            });
        },

        /**
         * Best effort: set a story's thread to hidden or public. Nothing to do when the story never
         * had a thread. Never throws; a failure is logged.
         */
        async setThreadVisibility(storyId, visibility, ctx) {
            const known = store.discussion.get(storyId);
            if (!known || !modTokens) return false;
            try {
                await call('PUT', `/api/v1/comments/threads/${encodeURIComponent(known.threadId)}/visibility`, { tokens: modTokens, body: { visibility }, ctx });
                return true;
            } catch (err) {
                log.warn(`[News] could not set the comment thread of ${storyId} to ${visibility}: ${err.message}`);
                return false;
            }
        },
    };
}

module.exports = { createCommunity };
