'use strict';

/**
 * Publication mechanics shared by the routes, the worker and ingestion:
 *   - canonical paths and URLs
 *   - the indexability gate (openvibe-publishing/seo) with News' editorial policy
 *   - the Search document and the publication events (openvibe-publishing/index-hooks), enqueued
 *     in the same transaction as the change through the SDK outbox
 *
 * News' gate policy: at least one source (citations are the Sources items the published revision
 * cites and that are still live upstream), at least 40 words; a paragraph whose every source was
 * removed upstream counts as an unsupported claim (noindex until an editor revises); a retraction
 * is noindex; AI-generated text is hidden until a person reviews it.
 *
 * Search receives ONLY published (not retracted), listable stories. Everything else is a tombstone,
 * so a retraction or an unpublish removes the old copy; a story that was never indexed gets no tombstone.
 */
const seo = require('openvibe-publishing/seo');
const hooks = require('openvibe-publishing/index-hooks');
const authorship = require('openvibe-publishing/authorship');

const POLICY = Object.freeze({ minWords: 40, requireSources: true, minSources: 1 });
const OWNER = 'news';

/**
 * AI-assisted text (hybrid: a person edited an AI draft) is held like AI-generated text: hidden
 * from indexes and not publishable until a person records an approving review of that revision.
 */
function gateAuthorship(rec, review) {
    if (rec.mode === 'hybrid') return { authorship: { mode: 'ai', reviewed: authorship.isReviewed(rec, review) }, ...(rec.stubProvider ? { stubProvider: true } : {}) };
    return authorship.gateFacts(rec, review);
}
function canPublish(rec, review) {
    if (rec.mode === 'hybrid' && !authorship.isReviewed(rec, review)) return { ok: false, reason: 'ai_assisted_unreviewed' };
    return authorship.canPublish(rec, review);
}
function disclosure(rec, review) {
    const d = rec ? authorship.disclosure(rec, review) : null;
    if (!d || rec.mode !== 'hybrid') return d;
    const reviewed = authorship.isReviewed(rec, review);
    return { ...d, long: `${d.long.replace(/\.\s*$/, '')}. ${reviewed ? 'Reviewed by a person.' : 'Not yet reviewed by a person.'}` };
}

function createPublication({ store, config, outbox }) {
    const { db } = store;
    const storyById = db.prepare('SELECT * FROM news_stories WHERE id = ?');
    const itemById = db.prepare('SELECT * FROM news_source_items WHERE id = ?');
    const topicById = db.prepare('SELECT * FROM news_topics WHERE id = ?');

    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const storyPath = (story) => `/stories/${story.slug}`;
    const storyUrl = (story) => abs(storyPath(story));
    const topicPath = (topic) => `/topics/${topic.slug}`;
    const feedId = (story) => `tag:openvibe.news,2026:story/${story.id}`;   // stable across slug changes

    const authorshipOf = (rev) => (rev && rev.meta && rev.meta.authorship) || null;
    const reviewOf = (story, rev) => (rev ? store.reviews.latest(story.id, rev.number) : null);
    const paragraphsOf = (rev) => (rev && rev.fields && Array.isArray(rev.fields.paragraphs) ? rev.fields.paragraphs : []);
    const snapshotOf = (rev) => (rev && rev.fields && Array.isArray(rev.fields.sources) ? rev.fields.sources : []);

    /** Live upstream state of every source a revision names: n → news_source_items row (or null). */
    function liveSources(rev) {
        const out = new Map();
        for (const s of snapshotOf(rev)) out.set(s.n, itemById.get(s.id) || null);
        return out;
    }

    /** What the revision rests on, against the live source records. */
    function support(rev) {
        const live = liveSources(rev);
        const alive = (n) => { const it = live.get(n); return Boolean(it && it.status !== 'removed'); };
        const cited = new Set();
        let unsupported = 0;
        for (const p of paragraphsOf(rev)) {
            const ns = Array.isArray(p.sources) ? p.sources : [];
            for (const n of ns) if (alive(n)) cited.add(n);
            if (!ns.some(alive)) unsupported++;
        }
        return { citedLive: cited.size, unsupported, live };
    }

    const plain = (rev) => (rev ? `${rev.fields.headline || ''}\n${paragraphsOf(rev).map((p) => p.text).join('\n')}` : '');

    function gateState(story, override) {
        const s = override || story.state;
        if (s === 'published' || s === 'retracted') return 'published';
        if (s === 'unpublished') return 'unpublished';
        return 'draft';
    }

    /** The gate's decision for a story at one revision (the published one by default). */
    function decide(story, rev, { state } = {}) {
        const sup = support(rev);
        const rec = authorshipOf(rev);
        const facts = {
            state: gateState(story, state),
            visibility: 'public',
            canonicalUrl: storyUrl(story),
            text: plain(rev),
            citationCount: sup.citedLive,
            unsupportedClaims: sup.unsupported,
            retracted: (state || story.state) === 'retracted',
            noindex: Boolean(story.noindex),
        };
        if (rec) Object.assign(facts, gateAuthorship(rec, reviewOf(story, rev)));
        return seo.evaluate(facts, { policy: POLICY, now: store.now() });
    }

    function topicOf(story) { return story.topic_id ? topicById.get(story.topic_id) : null; }

    /**
     * The index document as it would describe this story (for the product events), or a tombstone
     * when it is not published (or retracted).
     */
    function documentFor(story, { forSearch }) {
        const rev = story.published_revision ? store.revisions.get(story.id, story.published_revision) : null;
        const identity = { owner: OWNER, type: 'story', id: story.id, revision: 0 };
        if (!rev || story.state !== 'published') return { doc: hooks.tombstone(identity), decision: rev ? decide(story, rev) : null };
        const decision = decide(story, rev);
        if (forSearch && !decision.listable) return { doc: hooks.tombstone(identity), decision };
        const topic = topicOf(story);
        const outlets = [...new Set(snapshotOf(rev).map((s) => s.outlet).filter(Boolean))].slice(0, 50);
        const citations = store.citations.forRevision(story.id, rev.number).filter((c) => !c.anchor || !c.anchor.startsWith('t'));
        const seen = new Set();
        const uniqueCites = citations.filter((c) => { const k = c.sourceItemId || c.url; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 49);
        const doc = hooks.buildIndexDocument({
            ...identity,
            state: 'published',
            visibility: 'public',
            canonicalUrl: storyUrl(story),
            title: rev.fields.headline,
            summary: paragraphsOf(rev)[0] ? paragraphsOf(rev)[0].text : null,
            body: paragraphsOf(rev).map((p) => p.text).join('\n\n'),
            facets: { ...(topic ? { topic: topic.slug } : {}), outlets, sources: snapshotOf(rev).length },
            authorship: authorshipOf(rev),
            citations: uniqueCites,
            decision,
            publishedAt: story.first_published_at,
            updatedAt: rev.createdAt,
            language: 'en',
        });
        return { doc, decision };
    }

    /** Stamp and enqueue the Search document when it changed. Inside the caller's transaction. */
    function syncIndex(story, { traceparent } = {}) {
        const { doc } = documentFor(story, { forSearch: true });
        const prev = store.sequencer.current(OWNER, 'story', story.id);
        if (doc.deleted && prev == null) return null;
        const stamped = store.sequencer.stamp(doc);
        if (prev != null && stamped.revision === prev) return null;
        return outbox.emit(hooks.indexEvent({ document: stamped, now: store.now() }), { traceparent });
    }

    function snapshot(story) {
        return story ? { state: story.state, visibility: 'public', revision: story.published_revision, url: storyUrl(story) } : null;
    }

    /**
     * Emit the product event for a transition (news.story.published|updated|unpublished|retracted)
     * and re-sync Search. Inside the caller's transaction, after the row changed.
     */
    function afterChange(before, storyId, { actor, traceparent, extra = {} } = {}) {
        const story = storyById.get(storyId);
        const after = snapshot(story);
        let event = null;
        if (after.state === 'retracted' && (!before || before.state !== 'retracted')) {
            const d = decide(story, store.revisions.get(story.id, story.published_revision));
            event = outbox.emit({
                event_type: 'news.story.retracted', version: 1, source: OWNER, actor: actorRef(actor),
                timestamp: new Date(store.now()).toISOString(),
                visibility: d.listable ? 'public' : 'internal',
                subject: { type: 'story', id: story.id, revision: story.published_revision || 0 },
                payload: { canonical_url: storyUrl(story), publication_state: 'retracted', indexability: hooks.searchIndexability(d), ...extra },
            }, { traceparent });
        } else {
            // A retracted story is still published (with its notice) for the product events.
            const norm = (s) => (s && s.state === 'retracted' ? { ...s, state: 'published' } : s);
            let action = hooks.actionFor(norm(before), norm(after));
            if (!action && before && before.state === 'published' && after.state === 'published' && before.url !== after.url) action = 'updated';
            if (action) {
                const { doc, decision } = documentFor(story, { forSearch: false });
                const topic = topicOf(story);
                event = outbox.emit(hooks.publicationEvent({
                    product: OWNER, type: 'story', action, id: story.id, revision: story.published_revision || 0,
                    actor: actorRef(actor), document: doc, decision, now: store.now(),
                    extra: { ...(topic ? { topic: topic.slug } : {}), ...extra },
                }), { traceparent });
            }
        }
        syncIndex(story, { traceparent });
        return { story, event };
    }

    return {
        POLICY, OWNER, abs, storyPath, storyUrl, topicPath, feedId,
        authorshipOf, reviewOf, paragraphsOf, snapshotOf, liveSources, support, decide, topicOf,
        documentFor, syncIndex, snapshot, afterChange, plain,
    };
}

/** Event actor from a viewer (or svc:news for the system). */
function actorRef(actor) {
    if (!actor) return { type: 'service', id: 'news' };
    if (typeof actor === 'string') return hooks.subjectRef(actor);
    if (actor.kind === 'user' && actor.subject) return { type: 'user', id: actor.subject };
    if (actor.kind === 'service') {
        if (actor.subject && actor.origin !== 'ai') return { type: 'user', id: actor.subject };
        return { type: 'service', id: String(actor.service || '').replace(/^svc:/, '') || 'unknown' };
    }
    if (actor.type && actor.id) return { type: actor.type, id: actor.id };
    return { type: 'service', id: 'news' };
}

module.exports = { createPublication, actorRef, POLICY, canPublish, disclosure, gateAuthorship };
