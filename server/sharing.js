'use strict';

/**
 * Sharing for News stories and drafts (design 2026-11-06, VISIBILITY-EVERYWHERE step 4; openvibe-sdk/share).
 *
 * The SDK owns the model and the rules: the `shares` row next to each story, the one access check
 * (canView), members, access requests, transfers, the append-only log and the delivery queue. This
 * file is the wiring a service supplies:
 *
 *   - network.json       Network's identity lookups (@name → subject, and a person's card for the sheet)
 *   - events.publish     News' own outbox, so share.* envelopes go out with every news.* event
 *   - notify             Network's notification push; a refusal is logged, never allowed to stall the queue
 *   - onAudienceChange   keeps news_stories.audience in step; only Everyone is public to lists and Search
 *   - onOwnerChange      moves news_stories.created_by to the new owner
 *
 * A draft is Only me. The sheet on it can name someone ("look at this before I post it"); the
 * story page at /stories/:slug is the link, and it answers with the gate, never the headline or the
 * text, to anyone not on the list. A published story is Everyone unless its owner narrows it.
 */
const { createShares } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'news';
const KIND = 'story';
const AUDIENCES = ['public', 'link', 'people', 'private'];
/** News' visibility words to the SDK's, and back. */
const TO_SDK = { public: 'public', link: 'link', unlisted: 'link', people: 'people', private: 'private' };
const FROM_SDK = { public: 'public', link: 'private', people: 'private', private: 'private' };

const refOf = (id) => ({ service: SERVICE, kind: KIND, id: String(id) });

/** Blog's viewer as the SDK wants it: a subject object, and the staff bit. */
function shareViewer(v) {
    if (!v || !v.subject) return null;
    if (String(v.subject).startsWith('usr_')) return { subject: { type: 'user', id: v.subject }, staff: !!v.staff };
    if (String(v.subject).startsWith('gst_')) return { subject: { type: 'guest', id: v.subject }, staff: !!v.staff };
    return null;
}

function createSharing({ db, config, outbox, publication, now = Date.now, fetchImpl = globalThis.fetch, log = console } = {}) {
    async function publish(envelope) { await outbox.emit(envelope); }
    const base = String(config.networkInternalUrl || config.networkUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve network.notifications.push',
        fetchImpl,
    }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(`${base}${path}`);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Network ${method} ${path} ${res.status}: ${(body && (body.detail || body.error)) || 'failed'}`);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification, addressed by canonical subject. It never carries a post's title or text. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A story was shared with you', 'Open it on OpenVibe.News.'],
            'share.access_requested': ['Someone asked for access to your story', 'Review the request on OpenVibe.News.'],
            'share.transfer.requested': ['Someone wants to give you a story', 'Accept or decline it on OpenVibe.News.'],
            'share.transfer.answered': ['A story transfer was answered', 'See what happened on OpenVibe.News.'],
        }[n.kind] || ['Sharing on OpenVibe.News', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: 'news', url: n.ref && n.ref.id ? `${config.baseUrl}/stories/${encodeURIComponent(n.ref.id)}` : config.baseUrl,
                    category: 'social',
                },
            });
        } catch (err) {
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }



    /** The row's audience change keeps the column the lists read in step (a story page reads the row itself). */
    async function onAudienceChange(ref, audience, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        const row = await tx.maybe('SELECT * FROM news_stories WHERE id = $1', [ref.id]);
        if (!row) return;
        await tx.exec('UPDATE news_stories SET audience = $1, updated_at = $2 WHERE id = $3', [FROM_SDK[audience] || 'private', now(), ref.id]);
        if (row.state === 'published' && publication) {
            const changed = await tx.maybe('SELECT * FROM news_stories WHERE id = $1', [ref.id]);
            await publication.syncIndex(changed);
        }
    }

    async function onOwnerChange(ref, from, to, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        const owner = to && to.type === 'user' ? to.id : null;
        await tx.exec('UPDATE news_stories SET created_by = $1, updated_at = $3 WHERE id = $2', [owner, ref.id, now()]);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish },
        notify,
        onAudienceChange,
        onOwnerChange,
    });

    const sv = (viewer) => shareViewer(viewer);
    const at = (id) => refOf(id);

    async function defaultAudience(owner) {
        const row = await db.maybe('SELECT audience FROM news_share_defaults WHERE owner_subject = $1', [owner]);
        return row ? row.audience : 'private';
    }
    async function setDefaultAudience(owner, audience) {
        if (!['private', 'people'].includes(audience)) throw new Error('Invalid story draft default');
        await db.exec(`INSERT INTO news_share_defaults (owner_subject, audience) VALUES ($1, $2)
            ON CONFLICT (owner_subject) DO UPDATE SET audience = excluded.audience, updated_at = now()`, [owner, audience]);
    }
    async function applyDefault(owner, audience) {
        if (!['private', 'people'].includes(audience)) throw new Error('Invalid story draft default');
        const rows = await db.many(`SELECT id FROM news_stories WHERE created_by = $1 AND state IN ('draft', 'unpublished')`, [owner]);
        let changed = 0;
        for (const row of rows) {
            const current = await db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, row.id]);
            if (!current) {
                await shares.register(at(row.id), { owner_subject: { type: 'user', id: owner }, audience });
                await onAudienceChange(at(row.id), audience, db);
                changed++;
            } else if (current.audience !== audience) {
                await shares.setAudience(sv({ subject: owner }), at(row.id), audience);
                changed++;
            }
        }
        return changed;
    }

    return {
        shares,
        SERVICE,
        KIND,
        AUDIENCES,
        refOf,
        shareViewer,
        defaultAudience, setDefaultAudience, applyDefault,
        /** Register a post with the sharing system (inside the post's own transaction). */
        register: async (viewer, id, audience = 'private') => await shares.register(at(id), {
            owner_subject: viewer && viewer.subject ? { type: String(viewer.subject).startsWith('gst_') ? 'guest' : 'user', id: viewer.subject } : { type: 'service', id: SERVICE },
            audience: TO_SDK[audience] || 'private',
        }),
        /**
         * The service's own audience move (a create form, the editor's select, a publish). The caller
         * has already passed access.canWrite and owns the column and the Search sync; this only keeps
         * the share row in step. The SDK's owner check is for people using the sheet.
         */
        syncAudience: async (id, audience) => {
            const next = TO_SDK[audience] || 'private';
            await db.tx(async (t) => {
                const row = await t.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3 FOR UPDATE', [SERVICE, KIND, String(id)]);
                if (!row || row.audience === next) return;
                await t.exec('UPDATE shares SET audience = $1, revision = revision + 1 WHERE service = $2 AND kind = $3 AND resource_id = $4', [next, SERVICE, KIND, String(id)]);
                // News' lists read the column: publishing and unpublishing move it with the row.
                await t.exec('UPDATE news_stories SET audience = $1, updated_at = $2 WHERE id = $3', [FROM_SDK[next] || 'private', now(), String(id)]);
            });
        },
        shareOf: async (id) => await db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, String(id)]),
        canView: async (viewer, id) => await shares.canView(sv(viewer), at(id)),
        canEdit: async (viewer, id) => await shares.canEdit(sv(viewer), at(id)),
        get: async (viewer, id) => await shares.get(sv(viewer), at(id)),
        getWithRevision: async (viewer, id) => await shares.getWithRevision(sv(viewer), at(id)),
        setAudience: async (viewer, id, audience) => await shares.setAudience(sv(viewer), at(id), TO_SDK[audience] || 'private'),
        addMembers: async (viewer, id, list) => await shares.addMembers(sv(viewer), at(id), list),
        removeMember: async (viewer, id, subject) => await shares.removeMember(sv(viewer), at(id), subject),
        update: async (viewer, id, body, opts) => await shares.update(sv(viewer), at(id), body, opts),
        requestAccess: async (viewer, id) => await shares.requestAccess(sv(viewer), at(id)),
        dismiss: async (viewer, id, requestId) => await shares.dismiss(sv(viewer), at(id), requestId),
        transfer: async (viewer, id, input) => await shares.transfer(sv(viewer), at(id), input),
        accept: async (viewer, id, transferId) => await shares.accept(sv(viewer), at(id), transferId),
        decline: async (viewer, id, transferId) => await shares.decline(sv(viewer), at(id), transferId),
        cancel: async (viewer, id, transferId) => await shares.cancel(sv(viewer), at(id), transferId),
        lookup: async (viewer, name) => await shares.lookup(sv(viewer), name),
        sharedWithMe: async (viewer, opts) => await shares.sharedWithMe(sv(viewer), { service: SERVICE, ...(opts || {}) }),
        /** Expire members and transfers, then send queued events and notifications. */
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

/** The uniform API's describe(ref): the sheet shows the post's title and link to its owner. */
function describeRef(db, config) {
    return async (ref) => {
        if (ref.service !== SERVICE || ref.kind !== KIND) return {};
        const story = await db.maybe('SELECT id, slug, working_headline, state FROM news_stories WHERE id = $1', [ref.id]);
        if (!story) return {};
        return {
            title: story.working_headline || 'Untitled story',
            link: `${String(config.baseUrl || '').replace(/\/+$/, '')}/stories/${story.slug}`,
            roles: ['viewer'],
            audiences: AUDIENCES,
            transferable: true,
        };
    };
}

module.exports = { createSharing, describeRef, shareViewer, refOf, AUDIENCES, TO_SDK, FROM_SDK, SERVICE, KIND };
