'use strict';

/**
 * Stories: the editorial layer. An editor opens a story from a cluster, attaches source items
 * (the source table), writes paragraphs that each cite one or more of them, adds dated timeline
 * entries (each resting on a source) and groups sources into perspectives with labels the editor
 * writes. Every save is an immutable revision (openvibe-publishing/revisions, prefix news_story)
 * that snapshots the text, the source table, the timeline and the perspectives, so what readers
 * see is exactly one revision and never changes behind their back.
 *
 * Rules enforced here (tests: test/stories.test.js, test/upstream.test.js):
 *   - every paragraph cites ≥ 1 attached source; a revision with an uncited paragraph is refused
 *   - a story with zero sources cannot be published; neither can a revision that cites a source
 *     removed upstream or detached since, nor an AI revision no person has approved
 *   - when a cited source changes or is removed upstream, the story gets an editorial flag and a
 *     pending revision (system-prepared, same text, refreshed source table); the published
 *     revision stays as it is, with a visible notice, until an editor publishes a new one
 *   - a retraction keeps the story at its URL with a retraction notice; it is noindex and leaves
 *     sitemaps and Search
 *   - corrections and updates are flags published with the revision they belong to: the story's
 *     public correction history
 */
const { ids } = require('openvibe-contracts');
const { slugify } = require('openvibe-publishing/taxonomy');
const authorship = require('openvibe-publishing/authorship');
const { ApiError } = require('../http/errors');
const { actorRef, canPublish } = require('./publication');
const access = require('./access');

const MAX_PARAGRAPHS = 60;
const MAX_PARAGRAPH = 3000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MARKER = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const AI_WORKFLOWS = ['news.summarize_story', 'news.compare_perspectives'];

const newStoryId = (now) => `sty_${ids.ulid(now)}`;
const newFlagId = (now) => `flg_${ids.ulid(now)}`;
const newPerspectiveId = (now) => `per_${ids.ulid(now)}`;
const newTimelineId = (now) => `tle_${ids.ulid(now)}`;
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** "Text [1, 3]" paragraphs ↔ { text, sources: [1, 3] }. */
function parseBody(body) {
    const blocks = String(body == null ? '' : body).replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    return blocks.map((b) => {
        const sources = [];
        for (const m of b.matchAll(MARKER)) for (const n of m[1].split(',')) sources.push(parseInt(n, 10));
        return { text: b.replace(MARKER, '').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim(), sources: [...new Set(sources)] };
    });
}
function formatBody(paragraphs) {
    return (paragraphs || []).map((p) => `${p.text}${p.sources && p.sources.length ? ` [${p.sources.join(', ')}]` : ''}`).join('\n\n');
}

function createStories({ store, config, publication, clusters, outbox, ai = null, discussion = null, log = console }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM news_stories WHERE id = ?'),
        bySlug: db.prepare('SELECT * FROM news_stories WHERE slug = ?'),
        item: db.prepare('SELECT * FROM news_source_items WHERE id = ?'),
        itemBySources: db.prepare('SELECT * FROM news_source_items WHERE sources_item_id = ?'),
        topicBySlug: db.prepare("SELECT * FROM news_topics WHERE slug = ? AND status = 'active'"),
        topicById: db.prepare('SELECT * FROM news_topics WHERE id = ?'),
        links: db.prepare('SELECT * FROM news_story_sources WHERE story_id = ? ORDER BY position'),
        link: db.prepare('SELECT * FROM news_story_sources WHERE story_id = ? AND source_item_id = ?'),
        maxPos: db.prepare('SELECT COALESCE(MAX(position), 0) AS n FROM news_story_sources WHERE story_id = ?'),
        storiesCiting: db.prepare('SELECT DISTINCT story_id FROM news_story_sources WHERE source_item_id = ? AND detached_at IS NULL'),
        perspectives: db.prepare('SELECT * FROM news_perspectives WHERE story_id = ? AND removed_at IS NULL ORDER BY position, created_at, rowid'),
        perspective: db.prepare('SELECT * FROM news_perspectives WHERE id = ? AND story_id = ?'),
        timeline: db.prepare('SELECT * FROM news_timeline_entries WHERE story_id = ? AND removed_at IS NULL ORDER BY occurred_on, created_at, rowid'),
        flags: db.prepare('SELECT * FROM news_editorial_flags WHERE story_id = ? ORDER BY created_at, rowid'),
        openFlag: db.prepare("SELECT * FROM news_editorial_flags WHERE story_id = ? AND source_item_id = ? AND kind = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1"),
        insertFlag: db.prepare(`INSERT INTO news_editorial_flags (id, story_id, kind, status, note, source_item_id, pending_revision, revision, created_by, created_at, resolved_by, resolved_at)
                                VALUES (@id, @story_id, @kind, @status, @note, @source_item_id, @pending_revision, @revision, @created_by, @now, @resolved_by, @resolved_at)`),
    };

    const touch = (id) => db.prepare('UPDATE news_stories SET updated_at = ? WHERE id = ?').run(store.now(), id);

    function mustItem(ref) {
        const r = String(ref || '').trim();
        const it = r.startsWith('itm_') ? q.itemBySources.get(r) : q.item.get(r);
        if (!it) throw new ApiError(404, 'source_item.not_found', `No source item ${r}`);
        return it;
    }

    function topicFrom(v) {
        if (v == null || v === '') return null;
        const s = String(v);
        const t = s.startsWith('top_') ? q.topicById.get(s) : q.topicBySlug.get(s);
        if (!t) throw new ApiError(422, 'topic.not_found', `No active topic ${s}`);
        return t;
    }

    function slugFor(wanted, storyId = null) {
        let base;
        try { base = slugify(wanted).slice(0, 90); } catch { throw new ApiError(422, 'story.invalid_slug', 'That headline has no letters or digits to make a URL from'); }
        if (!SLUG_RE.test(base)) throw new ApiError(422, 'story.invalid_slug', 'slug must be lowercase letters, digits and dashes');
        for (let i = 1; i < 1000; i++) {
            const s = i === 1 ? base : `${base.slice(0, 85)}-${i}`;
            const hit = q.bySlug.get(s);
            if (!hit || hit.id === storyId) return s;
        }
        throw new ApiError(409, 'story.slug_taken', 'No free slug for that headline');
    }

    function actingEditor(viewer) { return access.requireEditor(config, viewer); }

    // ── The working source table, timeline and perspectives ─

    /** Attached sources with their items, in citation order: [{ n, item, perspective_id, detached_at }]. */
    function sourcesOf(story, { includeDetached = false } = {}) {
        return q.links.all(story.id).filter((l) => includeDetached || !l.detached_at).map((l) => ({ n: l.position, item: q.item.get(l.source_item_id), perspective_id: l.perspective_id, detached_at: l.detached_at, added_by: l.added_by }));
    }

    function sourceEntry(n, item, perspectiveId) {
        return {
            n, id: item.id, sources_item_id: item.sources_item_id, sources_revision: item.sources_revision,
            headline: item.headline, url: item.canonical_url, outlet: item.outlet, authors: parseJson(item.authors, []),
            published_at: item.published_at, retrieved_at: item.retrieved_at, summary: item.summary, status: item.status,
            ...(item.status === 'removed' ? { removed_reason: item.removed_reason } : {}),
            perspective: perspectiveId || null,
        };
    }

    /** What the next revision snapshots. */
    function buildSnapshot(story) {
        const srcs = sourcesOf(story);
        const byItem = new Map(srcs.map((s) => [s.item.id, s.n]));
        return {
            sources: srcs.map((s) => sourceEntry(s.n, s.item, s.perspective_id)),
            timeline: q.timeline.all(story.id).filter((t) => byItem.has(t.source_item_id)).map((t) => ({ id: t.id, occurred_on: t.occurred_on, text: t.text, source: byItem.get(t.source_item_id) })),
            perspectives: q.perspectives.all(story.id).map((p) => ({ id: p.id, label: p.label, description: p.description, sources: srcs.filter((s) => s.perspective_id === p.id).map((s) => s.n) })),
        };
    }

    function attachCitations(story, rev) {
        const byN = new Map((rev.fields.sources || []).map((s) => [s.n, s]));
        const list = [];
        (rev.fields.paragraphs || []).forEach((p, i) => {
            for (const n of p.sources || []) {
                const s = byN.get(n);
                if (s) list.push({ anchor: `p${i + 1}`, sourceItemId: s.sources_item_id, url: s.url || null, title: s.headline, retrievedAt: s.retrieved_at || null, attachedBy: 'svc:news' });
            }
        });
        for (const t of rev.fields.timeline || []) {
            const s = byN.get(t.source);
            if (s) list.push({ anchor: `t:${t.id}`, sourceItemId: s.sources_item_id, url: s.url || null, title: s.headline, retrievedAt: s.retrieved_at || null, attachedBy: 'svc:news' });
        }
        if (list.length) store.citations.attachMany(story.id, rev.number, list.slice(0, 500));
    }

    function authorshipFor(viewer, input, previous) {
        if (access.isAiDelivery(viewer)) {
            const a = input.authorship || {};
            const wf = a.workflow || {};
            if (!AI_WORKFLOWS.includes(wf.id)) throw new ApiError(422, 'story.ai_workflow_required', `AI drafts name their workflow: ${AI_WORKFLOWS.join(' or ')}`);
            return authorship.record({ mode: 'ai', workflow: { id: wf.id, runId: String(wf.runId || wf.run_id || ''), version: wf.version, model: wf.model }, stubProvider: Boolean(a.stubProvider || a.stub_provider), source: { label: 'the story’s source items' } });
        }
        if (previous && (previous.mode === 'ai' || previous.mode === 'hybrid') && previous.workflow) {
            return authorship.record({ mode: 'hybrid', authors: [viewer.subject], workflow: previous.workflow });
        }
        return authorship.record({ mode: 'human', authors: [viewer.subject] });
    }

    function authorLabel(viewer) {
        if (viewer.kind === 'service') return viewer.origin === 'ai' ? `${viewer.service} (ai)` : `${viewer.service} for ${viewer.subject}`;
        return viewer.subject;
    }

    /** Normalise and check paragraphs against the attached (not detached) source numbers. */
    function checkParagraphs(paragraphs, attached) {
        if (!Array.isArray(paragraphs) || !paragraphs.length) throw new ApiError(422, 'story.no_text', 'A revision needs at least one paragraph');
        if (paragraphs.length > MAX_PARAGRAPHS) throw new ApiError(422, 'story.too_long', `At most ${MAX_PARAGRAPHS} paragraphs`);
        return paragraphs.map((p, i) => {
            const text = clean(p && p.text, MAX_PARAGRAPH + 1);
            if (!text) throw new ApiError(422, 'story.empty_paragraph', `Paragraph ${i + 1} is empty`);
            if (text.length > MAX_PARAGRAPH) throw new ApiError(422, 'story.paragraph_too_long', `Paragraph ${i + 1} is longer than ${MAX_PARAGRAPH} characters`);
            const sources = [...new Set((Array.isArray(p.sources) ? p.sources : []).map((n) => parseInt(n, 10)).filter(Number.isInteger))].sort((a, b) => a - b);
            if (!sources.length) throw new ApiError(422, 'story.claim_unsourced', `Paragraph ${i + 1} cites no source: end it with the source numbers it rests on, e.g. [1] or [1, 3]`);
            for (const n of sources) if (!attached.has(n)) throw new ApiError(422, 'story.unknown_source', `Paragraph ${i + 1} cites [${n}], which is not in this story's source table`);
            return { text, sources };
        });
    }

    /** Paragraphs from the API (by item id or number) or from the form body (markers). */
    function paragraphsFrom(story, input) {
        if (Array.isArray(input.paragraphs)) {
            const numberOf = new Map(sourcesOf(story).map((s) => [s.item.id, s.n]).concat(sourcesOf(story).map((s) => [s.item.sources_item_id, s.n])));
            return input.paragraphs.map((p) => ({ text: p && p.text, sources: (Array.isArray(p && p.sources) ? p.sources : []).map((x) => (typeof x === 'number' ? x : numberOf.get(String(x)) || -1)) }));
        }
        if (input.body !== undefined) return parseBody(input.body);
        return null;
    }

    /** Everything that stands between a revision and publication. → [{ code, detail }] */
    function problems(story, rev) {
        const out = [];
        if (!rev) return [{ code: 'story.no_text', detail: 'Nothing has been written yet' }];
        const snap = rev.fields.sources || [];
        if (!snap.length) out.push({ code: 'story.unsourced', detail: 'A story with zero sources cannot be published: attach the source items it rests on' });
        const paragraphs = rev.fields.paragraphs || [];
        if (!paragraphs.length) out.push({ code: 'story.no_text', detail: 'The revision has no paragraphs' });
        const live = publication.liveSources(rev);
        const links = new Map(q.links.all(story.id).map((l) => [l.source_item_id, l]));
        const cited = new Set();
        paragraphs.forEach((p, i) => {
            if (!p.sources || !p.sources.length) out.push({ code: 'story.claim_unsourced', detail: `Paragraph ${i + 1} cites no source` });
            for (const n of p.sources || []) cited.add(n);
        });
        for (const t of rev.fields.timeline || []) cited.add(t.source);
        for (const n of [...cited].sort((a, b) => a - b)) {
            const entry = snap.find((s) => s.n === n);
            const it = live.get(n);
            if (!entry || !it) { out.push({ code: 'story.unknown_source', detail: `[${n}] is not in the revision's source table` }); continue; }
            if (it.status === 'removed') out.push({ code: 'story.source_removed', detail: `[${n}] (${it.outlet}) was removed upstream: ${it.removed_reason || 'no reason given'} — revise the text so nothing rests on it` });
            const link = links.get(it.id);
            if (!link || link.detached_at) out.push({ code: 'story.source_detached', detail: `[${n}] was detached from the story` });
        }
        const rec = publication.authorshipOf(rev) || { mode: 'human' };
        const ok = canPublish(rec, publication.reviewOf(story, rev));
        if (!ok.ok) out.push({ code: 'story.review_required', detail: `Revision ${rev.number} is ${rec.mode === 'hybrid' ? 'AI-assisted' : 'AI-generated'} (${ok.reason}): a person must review and approve it first` });
        if (!clean(rev.fields.headline, 300)) out.push({ code: 'story.no_headline', detail: 'The revision has no headline' });
        return out;
    }

    function flagRow(story, { kind, status = 'open', note = null, sourceItemId = null, pendingRevision = null, revision = null, createdBy, resolvedBy = null, resolvedAt = null }) {
        const now = store.now();
        const id = newFlagId(now);
        q.insertFlag.run({ id, story_id: story.id, kind, status, note, source_item_id: sourceItemId, pending_revision: pendingRevision, revision, created_by: createdBy, now, resolved_by: resolvedBy, resolved_at: resolvedAt });
        return db.prepare('SELECT * FROM news_editorial_flags WHERE id = ?').get(id);
    }

    function flagEvent(story, flag, traceparent) {
        outbox.emit({
            event_type: 'news.story.flagged', actor: flag.created_by === 'svc:news' ? { type: 'service', id: 'news' } : actorRef(flag.created_by),
            visibility: 'internal', priority: flag.kind === 'source_removed' ? 'important' : 'normal',
            subject: { type: 'story', id: story.id, revision: flag.pending_revision || story.published_revision || 0 },
            payload: { flag_id: flag.id, kind: flag.kind, status: flag.status, source_item_id: flag.source_item_id, pending_revision: flag.pending_revision, published_revision: story.published_revision },
        }, { traceparent });
    }

    const api = {
        parseBody, formatBody, AI_WORKFLOWS,

        get: (id) => q.byId.get(String(id || '')) || null,
        bySlug: (slug) => q.bySlug.get(String(slug || '')) || null,
        mustGet(id) {
            const s = api.get(id);
            if (!s) throw new ApiError(404, 'story.not_found', 'No such story');
            return s;
        },
        sources: sourcesOf,
        buildSnapshot,
        perspectives: (story) => q.perspectives.all(story.id),
        timeline: (story) => q.timeline.all(story.id),
        flags: (story) => q.flags.all(story.id),
        publicFlags: (story) => q.flags.all(story.id).filter((f) => f.status === 'published' && ['correction', 'update', 'retraction'].includes(f.kind)),
        openUpstreamFlags: (story) => q.flags.all(story.id).filter((f) => f.status === 'open' && (f.kind === 'source_updated' || f.kind === 'source_removed')),
        head: (story) => store.revisions.head(story.id),
        revision: (story, n) => store.revisions.get(story.id, n),
        revisions: (story, opts) => store.revisions.list(story.id, opts),
        diff: (story, from, to, mode) => store.revisions.diff(story.id, from, to, { mode: mode === 'word' ? 'word' : 'line' }),
        problems,

        /** Published and retracted stories (retracted ones stay listed with their notice). */
        listPublished({ topicId = null, limit = 20, offset = 0 } = {}) {
            const where = ["state IN ('published','retracted')"];
            const args = [];
            if (topicId) { where.push('topic_id = ?'); args.push(topicId); }
            const w = where.join(' AND ');
            const total = db.prepare(`SELECT COUNT(*) AS n FROM news_stories WHERE ${w}`).get(...args).n;
            const rows = db.prepare(`SELECT * FROM news_stories WHERE ${w} ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
            return { total, stories: rows };
        },

        /** Every story, for editors. */
        listAll({ limit = 200 } = {}) {
            return db.prepare('SELECT * FROM news_stories ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit);
        },
        byCluster: (clusterId) => db.prepare('SELECT * FROM news_stories WHERE cluster_id = ? ORDER BY created_at').all(clusterId),

        /**
         * An editor opens a story from a cluster: the cluster's live, non-duplicate items are
         * attached as the first sources. Optional first text (headline + body) becomes revision 1.
         */
        create(viewer, input = {}, { traceparent } = {}) {
            const subject = actingEditor(viewer);
            const headline = clean(input.headline, 201);
            if (!headline) throw new ApiError(422, 'story.no_headline', 'A story needs a working headline');
            if (headline.length > 200) throw new ApiError(422, 'story.no_headline', 'A headline is at most 200 characters');
            let cluster = null;
            if (input.cluster || input.clusterId || input.cluster_id) {
                cluster = clusters.get(input.cluster || input.clusterId || input.cluster_id);
                if (!cluster) throw new ApiError(404, 'cluster.not_found', 'No such cluster');
                cluster = clusters.resolve(cluster.id);
            }
            const topic = topicFrom(input.topic);
            return store.tx(() => {
                const now = store.now();
                const id = newStoryId(now);
                const slug = slugFor(input.slug || headline);
                db.prepare(`INSERT INTO news_stories (id, slug, working_headline, cluster_id, topic_id, state, noindex, created_by, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?)`).run(id, slug, headline, cluster ? cluster.id : null, topic ? topic.id : null, subject, now, now);
                const story = q.byId.get(id);
                if (cluster) {
                    const items = clusters.members(cluster.id).filter((it) => it.status === 'active')
                        .sort((a, b) => String(a.published_at || '').localeCompare(String(b.published_at || '')) || a.first_seen_at - b.first_seen_at || (a.id < b.id ? -1 : 1));
                    items.forEach((it, i) => db.prepare('INSERT INTO news_story_sources (story_id, source_item_id, position, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(id, it.id, i + 1, subject, now));
                }
                outbox.emit({
                    event_type: 'news.story.created', actor: actorRef(viewer), visibility: 'internal', priority: 'low',
                    subject: { type: 'story', id }, payload: { cluster_id: cluster ? cluster.id : null, topic: topic ? topic.slug : null, sources: sourcesOf(story).length },
                }, { traceparent });
                let revision = null;
                if (input.body !== undefined || Array.isArray(input.paragraphs)) {
                    revision = api.revise(viewer, story, { headline, body: input.body, paragraphs: input.paragraphs, expectedRevision: 0, message: 'First draft' }).revision;
                }
                return { story: q.byId.get(id), revision };
            });
        },

        attach(viewer, story, { item }) {
            const subject = actingEditor(viewer);
            const it = mustItem(item);
            if (it.status === 'removed') throw new ApiError(409, 'source_item.removed', `${it.id} was removed upstream (${it.removed_reason || 'no reason given'}) and cannot be cited`);
            return store.tx(() => {
                const link = q.link.get(story.id, it.id);
                if (link && !link.detached_at) return { n: link.position, item: it, created: false };
                if (link) db.prepare('UPDATE news_story_sources SET detached_at = NULL WHERE story_id = ? AND source_item_id = ?').run(story.id, it.id);
                else db.prepare('INSERT INTO news_story_sources (story_id, source_item_id, position, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(story.id, it.id, q.maxPos.get(story.id).n + 1, subject, store.now());
                touch(story.id);
                return { n: q.link.get(story.id, it.id).position, item: it, created: true };
            });
        },

        /** Detach a source (its number is never reused). The next revision must not cite it. */
        detach(viewer, story, item) {
            actingEditor(viewer);
            const it = mustItem(item);
            const link = q.link.get(story.id, it.id);
            if (!link || link.detached_at) throw new ApiError(404, 'story.source_not_attached', `${it.id} is not attached to this story`);
            db.prepare('UPDATE news_story_sources SET detached_at = ? WHERE story_id = ? AND source_item_id = ?').run(store.now(), story.id, it.id);
            db.prepare('UPDATE news_timeline_entries SET removed_at = ? WHERE story_id = ? AND source_item_id = ? AND removed_at IS NULL').run(store.now(), story.id, it.id);
            touch(story.id);
            return { detached: true, n: link.position };
        },

        addPerspective(viewer, story, { label, description = null }) {
            const subject = actingEditor(viewer);
            const l = clean(label, 81);
            if (!l) throw new ApiError(422, 'perspective.no_label', 'A perspective needs a label an editor writes (for example the outlet group or the position it states)');
            if (l.length > 80) throw new ApiError(422, 'perspective.label_too_long', 'A label is at most 80 characters');
            const now = store.now();
            const id = newPerspectiveId(now);
            const pos = q.perspectives.all(story.id).length;
            db.prepare('INSERT INTO news_perspectives (id, story_id, label, description, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(id, story.id, l, description ? clean(description, 500) : null, pos, subject, now, now);
            touch(story.id);
            return q.perspective.get(id, story.id);
        },

        removePerspective(viewer, story, perspectiveId) {
            actingEditor(viewer);
            const p = q.perspective.get(String(perspectiveId || ''), story.id);
            if (!p || p.removed_at) throw new ApiError(404, 'perspective.not_found', 'No such perspective');
            store.tx(() => {
                db.prepare('UPDATE news_perspectives SET removed_at = ?, updated_at = ? WHERE id = ?').run(store.now(), store.now(), p.id);
                db.prepare('UPDATE news_story_sources SET perspective_id = NULL WHERE story_id = ? AND perspective_id = ?').run(story.id, p.id);
            });
            touch(story.id);
            return { removed: true };
        },

        /** Put an attached source in a perspective (or none). */
        assignPerspective(viewer, story, item, perspectiveId) {
            actingEditor(viewer);
            const it = mustItem(item);
            const link = q.link.get(story.id, it.id);
            if (!link || link.detached_at) throw new ApiError(404, 'story.source_not_attached', `${it.id} is not attached to this story`);
            let pid = null;
            if (perspectiveId) {
                const p = q.perspective.get(String(perspectiveId), story.id);
                if (!p || p.removed_at) throw new ApiError(404, 'perspective.not_found', 'No such perspective');
                pid = p.id;
            }
            db.prepare('UPDATE news_story_sources SET perspective_id = ? WHERE story_id = ? AND source_item_id = ?').run(pid, story.id, it.id);
            touch(story.id);
            return { n: link.position, perspective_id: pid };
        },

        /** A dated entry resting on one attached source. The date is what the source states. */
        addTimeline(viewer, story, { occurredOn, text: entryText, source }) {
            const subject = actingEditor(viewer);
            const on = String(occurredOn || '').trim();
            if (!DATE_RE.test(on) || !Number.isFinite(Date.parse(on))) throw new ApiError(422, 'timeline.invalid_date', 'occurred_on must be a date the source states (YYYY-MM-DD or an ISO 8601 time)');
            const t = clean(entryText, 501);
            if (!t) throw new ApiError(422, 'timeline.no_text', 'A timeline entry needs text');
            if (t.length > 500) throw new ApiError(422, 'timeline.too_long', 'A timeline entry is at most 500 characters');
            let it;
            if (/^\d+$/.test(String(source))) {
                const s = sourcesOf(story).find((x) => x.n === parseInt(source, 10));
                if (!s) throw new ApiError(422, 'timeline.unknown_source', `[${source}] is not in this story's source table`);
                it = s.item;
            } else {
                it = mustItem(source);
                const link = q.link.get(story.id, it.id);
                if (!link || link.detached_at) throw new ApiError(422, 'timeline.unknown_source', 'The source must be attached to the story');
            }
            if (it.status === 'removed') throw new ApiError(409, 'source_item.removed', 'That source was removed upstream');
            const now = store.now();
            const id = newTimelineId(now);
            db.prepare('INSERT INTO news_timeline_entries (id, story_id, occurred_on, text, source_item_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, story.id, on, t, it.id, subject, now);
            touch(story.id);
            return db.prepare('SELECT * FROM news_timeline_entries WHERE id = ?').get(id);
        },

        removeTimeline(viewer, story, entryId) {
            actingEditor(viewer);
            const r = db.prepare('UPDATE news_timeline_entries SET removed_at = ? WHERE id = ? AND story_id = ? AND removed_at IS NULL').run(store.now(), String(entryId || ''), story.id);
            if (!r.changes) throw new ApiError(404, 'timeline.not_found', 'No such timeline entry');
            touch(story.id);
            return { removed: true };
        },

        /**
         * A new revision: headline + paragraphs (each citing ≥ 1 attached source) + the snapshot of
         * the source table, timeline and perspectives. expectedRevision is required once a revision
         * exists (412 revision.conflict on a stale base). Editors write human (or, after an AI draft,
         * hybrid) revisions; an AI delivery writes an AI revision that needs a person's review.
         */
        revise(viewer, story, input = {}, { traceparent } = {}) {
            const ai = access.isAiDelivery(viewer);
            if (!ai) actingEditor(viewer);
            if (story.state === 'retracted') throw new ApiError(409, 'story.retracted', 'A retracted story is not revised; open a new story');
            return store.tx(() => {
                const head = store.revisions.head(story.id);
                const expected = input.expectedRevision ?? input.expected_revision;
                if (head && (expected == null || expected === '')) throw new ApiError(428, 'revision.expected_required', 'Send expectedRevision (the revision you edited) so concurrent edits are not lost');
                const headline = input.headline !== undefined && input.headline !== null ? clean(input.headline, 201) : (head ? head.fields.headline : story.working_headline);
                if (!headline) throw new ApiError(422, 'story.no_headline', 'A revision needs a headline');
                if (headline.length > 200) throw new ApiError(422, 'story.no_headline', 'A headline is at most 200 characters');
                const attached = new Set(sourcesOf(story).map((s) => s.n));
                const given = paragraphsFrom(story, input);
                const paragraphs = checkParagraphs(given || (head ? head.fields.paragraphs : []), attached);
                const snap = buildSnapshot(story);
                const prevRec = head ? publication.authorshipOf(head) : null;
                const rec = authorshipFor(viewer, input, prevRec);
                const meta = { authorship: rec };
                if (ai && Array.isArray(input.gaps) && input.gaps.length) meta.gaps = input.gaps.map((g) => clean(g, 300)).slice(0, 20);
                const out = store.revisions.create({
                    entityId: story.id, expectedRevision: head ? parseInt(expected, 10) : 0,
                    content: formatBody(paragraphs), fields: { headline, paragraphs, ...snap }, meta,
                    author: authorLabel(viewer), message: input.message ? clean(input.message, 200) : null,
                });
                if (out.created) attachCitations(story, out.revision);
                const sets = { working_headline: headline };
                if (!ai && input.topic !== undefined) { const t = topicFrom(input.topic); sets.topic_id = t ? t.id : null; }
                if (!ai && input.noindex !== undefined) sets.noindex = input.noindex === true || input.noindex === '1' || input.noindex === 1 ? 1 : 0;
                const keys = Object.keys(sets).filter((k) => k !== 'working_headline');
                db.prepare(`UPDATE news_stories SET ${Object.keys(sets).map((k) => `${k} = @${k}`).concat('updated_at = @now').join(', ')} WHERE id = @id`).run({ ...sets, now: store.now(), id: story.id });
                if (keys.length && story.state === 'published') publication.afterChange(publication.snapshot(story), story.id, { actor: viewer, traceparent });
                return { revision: out.revision, created: out.created, story: q.byId.get(story.id) };
            });
        },

        /**
         * Publish revision N (default: the head). Refused while anything in problems() stands.
         * Open correction/update flags are published with it; upstream flags the revision answers
         * are resolved. Republishing after a source was removed needs a correction or update note.
         */
        publish(viewer, story, { revision, correction } = {}, { traceparent } = {}) {
            actingEditor(viewer);
            if (story.state === 'retracted') throw new ApiError(409, 'story.retracted', 'A retracted story stays retracted; open a new story');
            return store.tx(() => {
                const cur = q.byId.get(story.id);
                if (discussion) discussion.watch(story.id);
                const rev = revision == null || revision === '' ? store.revisions.head(story.id) : store.revisions.get(story.id, parseInt(revision, 10));
                if (!rev && revision != null && revision !== '') throw new ApiError(404, 'revision.not_found', `No revision ${revision}`);
                const found = problems(cur, rev);
                if (found.length) {
                    const status = found.some((p) => p.code === 'story.review_required' || p.code === 'story.source_removed' || p.code === 'story.source_detached') ? 409 : 422;
                    throw new ApiError(status, found[0].code, found.map((p) => p.detail).join(' · '), { problems: found });
                }
                if (cur.state === 'published' && cur.published_revision === rev.number && !correction) return { changed: false, story: cur };
                const citedIds = new Set();
                for (const p of rev.fields.paragraphs) for (const n of p.sources) { const s = rev.fields.sources.find((x) => x.n === n); if (s) citedIds.add(s.id); }
                const upstream = q.flags.all(story.id).filter((f) => f.status === 'open' && (f.kind === 'source_updated' || f.kind === 'source_removed'));
                const answers = (f) => {
                    const it = q.item.get(f.source_item_id);
                    const entry = rev.fields.sources.find((s) => s.id === f.source_item_id);
                    if (f.kind === 'source_removed') return !citedIds.has(f.source_item_id) && !(rev.fields.timeline || []).some((t) => entry && t.source === entry.n);
                    return !entry || !it || entry.sources_revision >= it.sources_revision;
                };
                const resolving = upstream.filter(answers);
                const note = correction && correction.note ? clean(correction.note, 2001) : '';
                const kind = correction && correction.kind ? String(correction.kind) : (note ? 'correction' : null);
                if (kind && !['correction', 'update'].includes(kind)) throw new ApiError(422, 'flag.invalid_kind', 'kind is correction or update');
                if (note.length > 2000) throw new ApiError(422, 'flag.note_too_long', 'A note is at most 2000 characters');
                if (cur.first_published_at && resolving.some((f) => f.kind === 'source_removed') && !note && !q.flags.all(story.id).some((f) => f.status === 'open' && (f.kind === 'correction' || f.kind === 'update') && f.note)) {
                    throw new ApiError(422, 'story.correction_note_required', 'A source this story cited was removed upstream: say what changed in a correction or update note readers will see');
                }
                const now = store.now();
                const before = publication.snapshot(cur);
                db.prepare(`UPDATE news_stories SET state = 'published', published_revision = ?, first_published_at = COALESCE(first_published_at, ?),
                            published_at = ?, updated_at = ? WHERE id = ?`).run(rev.number, now, now, now, story.id);
                const subject = viewer.subject;
                for (const f of q.flags.all(story.id).filter((x) => x.status === 'open' && (x.kind === 'correction' || x.kind === 'update'))) {
                    db.prepare("UPDATE news_editorial_flags SET status = 'published', revision = ?, resolved_by = ?, resolved_at = ? WHERE id = ?").run(rev.number, subject, now, f.id);
                }
                if (note) flagRow(cur, { kind, status: 'published', note, revision: rev.number, createdBy: subject, resolvedBy: subject, resolvedAt: now });
                for (const f of resolving) db.prepare("UPDATE news_editorial_flags SET status = 'resolved', revision = ?, resolved_by = ?, resolved_at = ? WHERE id = ?").run(rev.number, subject, now, f.id);
                const out = publication.afterChange(before, story.id, { actor: viewer, traceparent });
                return { changed: true, story: out.story, resolved: resolving.map((f) => f.id) };
            });
        },

        unpublish(viewer, story, { traceparent } = {}) {
            actingEditor(viewer);
            return store.tx(() => {
                const cur = q.byId.get(story.id);
                if (cur.state !== 'published' && cur.state !== 'retracted') return { changed: false, story: cur };
                if (discussion) discussion.watch(story.id);
                const before = publication.snapshot(cur);
                db.prepare("UPDATE news_stories SET state = 'unpublished', updated_at = ? WHERE id = ?").run(store.now(), story.id);
                return { changed: true, story: publication.afterChange(before, story.id, { actor: viewer, traceparent }).story };
            });
        },

        /** Retract: the story stays at its URL with the retraction notice; noindex; out of Search. */
        retract(viewer, story, { note } = {}, { traceparent } = {}) {
            const subject = actingEditor(viewer);
            const n = clean(note, 2001);
            if (n.length < 10) throw new ApiError(422, 'story.retraction_note_required', 'A retraction says why, in at least a sentence readers will see');
            if (n.length > 2000) throw new ApiError(422, 'flag.note_too_long', 'A note is at most 2000 characters');
            return store.tx(() => {
                const cur = q.byId.get(story.id);
                if (cur.state === 'retracted') return { changed: false, story: cur };
                if (cur.state !== 'published') throw new ApiError(409, 'story.not_published', 'Only a published story can be retracted');
                if (discussion) discussion.watch(story.id);
                const now = store.now();
                const before = publication.snapshot(cur);
                db.prepare("UPDATE news_stories SET state = 'retracted', retracted_at = ?, updated_at = ? WHERE id = ?").run(now, now, story.id);
                const flag = flagRow(cur, { kind: 'retraction', status: 'published', note: n, revision: cur.published_revision, createdBy: subject, resolvedBy: subject, resolvedAt: now });
                const out = publication.afterChange(before, story.id, { actor: viewer, traceparent, extra: { note: n, flag_id: flag.id } });
                return { changed: true, story: out.story, flag };
            });
        },

        /** A correction or update note, published with the next publication. */
        addFlag(viewer, story, { kind, note } = {}) {
            const subject = actingEditor(viewer);
            if (!['correction', 'update'].includes(kind)) throw new ApiError(422, 'flag.invalid_kind', 'kind is correction or update (retractions use the retract action)');
            const n = clean(note, 2001);
            if (!n) throw new ApiError(422, 'flag.no_note', 'A correction or update note is public text: write it');
            if (n.length > 2000) throw new ApiError(422, 'flag.note_too_long', 'A note is at most 2000 characters');
            return flagRow(story, { kind, note: n, createdBy: subject });
        },

        /** A person's review of one revision (what lets an AI draft be published and indexed). */
        review(viewer, story, { revision, decision, note } = {}, { traceparent } = {}) {
            if (!viewer || viewer.kind !== 'user' || !viewer.subject) throw new ApiError(403, 'review.person_required', 'Only a signed-in person can review a revision');
            actingEditor(viewer);
            const n = parseInt(revision, 10);
            if (!store.revisions.get(story.id, n)) throw new ApiError(404, 'revision.not_found', `No revision ${revision}`);
            return store.tx(() => {
                const row = store.reviews.record({ entityId: story.id, revision: n, reviewer: viewer.subject, decision, note });
                if (story.state === 'published') publication.syncIndex(q.byId.get(story.id), { traceparent });
                return row;
            });
        },

        /**
         * A cited source changed (source_updated) or was removed (source_removed) upstream. For every
         * story it is attached to: an open flag, and — when the story has text — a pending revision
         * with the same paragraphs and the refreshed source entry. Nothing is published here.
         * Runs inside the ingest transaction.
         */
        onUpstreamChange(item, kind) {
            const affected = [];
            for (const { story_id: sid } of q.storiesCiting.all(item.id)) {
                const story = q.byId.get(sid);
                if (!story) continue;
                const open = q.openFlag.get(story.id, item.id, kind);
                if (open && kind === 'source_removed') continue;
                const head = store.revisions.head(story.id);
                let pending = null;
                if (head) {
                    const sources = (head.fields.sources || []).map((s) => (s.id === item.id ? sourceEntry(s.n, item, s.perspective) : s));
                    const fields = { ...head.fields, sources };
                    const out = store.revisions.create({
                        entityId: story.id, expectedRevision: head.number, content: head.content, fields,
                        meta: { authorship: head.meta.authorship, system: { reason: kind, source_item_id: item.id, sources_item_id: item.sources_item_id, sources_revision: item.sources_revision, based_on: head.number } },
                        author: 'svc:news',
                        message: kind === 'source_removed' ? `A cited source (${item.outlet}) was removed upstream: an editor must revise` : `A cited source (${item.outlet}) changed upstream: an editor must check the text`,
                    });
                    if (out.created) {
                        pending = out.revision.number;
                        store.citations.carryForward({ entityId: story.id, fromRevision: head.number, toRevision: pending, attachedBy: 'svc:news' });
                    }
                }
                let flag;
                if (open) {
                    if (pending) db.prepare('UPDATE news_editorial_flags SET pending_revision = ? WHERE id = ?').run(pending, open.id);
                    flag = db.prepare('SELECT * FROM news_editorial_flags WHERE id = ?').get(open.id);
                } else {
                    flag = flagRow(story, { kind, sourceItemId: item.id, pendingRevision: pending, revision: story.published_revision, createdBy: 'svc:news', note: kind === 'source_removed' ? (item.removed_reason || null) : null });
                }
                touch(story.id);
                flagEvent(story, flag);
                if (story.state === 'published') publication.syncIndex(q.byId.get(story.id));
                affected.push({ story: story.id, flag: flag.id, pending_revision: pending });
                log.warn && log.warn(`[News] ${kind} for ${item.id}: story ${story.id} flagged${pending ? `, pending revision ${pending}` : ''}`);
            }
            return affected;
        },

        /**
         * Ask OpenVibe.AI for a draft (news.summarize_story / news.compare_perspectives). The result
         * is an AI revision that cannot be published until a person approves it; a failure makes no text.
         */
        async aiDraft(viewer, story, workflow, { traceparent } = {}) {
            actingEditor(viewer);
            if (!ai || !ai.enabled) throw new ApiError(503, 'ai.not_configured', 'OpenVibe.AI is not configured on this server; write the story from the source items');
            const srcs = sourcesOf(story).filter((s) => s.item.status !== 'removed');
            if (!srcs.length) throw new ApiError(422, 'story.unsourced', 'Attach source items first');
            if (workflow === 'news.compare_perspectives' && srcs.length < 2) throw new ApiError(422, 'story.too_few_sources', 'Comparing perspectives needs at least two sources');
            const topic = publication.topicOf(story);
            const head = store.revisions.head(story.id);
            let result;
            try {
                result = await ai.run(workflow, {
                    topic: head ? head.fields.headline : (topic ? topic.name : null),
                    sources: srcs.map((s) => ({ id: s.item.id, sources_item_id: s.item.sources_item_id, headline: s.item.headline, url: s.item.canonical_url, outlet: s.item.outlet,
                        authors: parseJson(s.item.authors, []), published_at: s.item.published_at, retrieved_at: s.item.retrieved_at, summary: s.item.summary })),
                });
            } catch (err) {
                throw new ApiError(err.status || 502, err.code || 'ai.failed', err.message);
            }
            const { draftFromOutput } = require('../clients/ai');
            const draft = draftFromOutput(workflow, result.output, srcs.map((s) => s.n));
            if (!draft.paragraphs.length) throw new ApiError(422, 'ai.nothing_cited', `The ${workflow} run returned no cited text; no draft was made${draft.gaps.length ? ` (${draft.gaps.slice(0, 3).join('; ')})` : ''}`);
            const aiViewer = { kind: 'service', service: 'svc:ai', origin: 'ai', subject: null };
            const fresh = q.byId.get(story.id);
            const cur = store.revisions.head(story.id);
            return api.revise(aiViewer, fresh, {
                headline: draft.headline || (cur ? cur.fields.headline : fresh.working_headline),
                paragraphs: draft.paragraphs, expectedRevision: cur ? cur.number : 0, gaps: draft.gaps,
                authorship: { workflow: result.workflow, stubProvider: result.stub },
                message: `AI draft (${workflow}, run ${result.runId}) requested by ${viewer.subject}`,
            }, { traceparent });
        },
    };
    return api;
}

module.exports = { createStories, parseBody, formatBody, AI_WORKFLOWS };
