'use strict';

/**
 * What readers get: one model per story, built from the published revision's snapshot and the live
 * state of its sources, used by the HTML page, the .json twin, feeds and JSON-LD alike (no
 * divergence between what people and machines see).
 *
 * Public masking: a source that has since been REMOVED upstream shows only its number, outlet and
 * the fact of the removal — no headline, summary or link — so material withdrawn for licensing or
 * legal reasons never stays in public text. Open upstream flags are shown as a notice; the text of
 * the published revision itself never changes.
 */
const seo = require('openvibe-publishing/seo');
const { disclosure } = require('./publication');

const iso = (v) => (v == null ? null : new Date(v).toISOString());

function createReading({ store, config, stories, publication, people, topics }) {
    /** The public model of a story at a revision (the published one unless given). */
    async function storyModel(story, { rev = null, editorView = false } = {}) {
        const r = rev || (story.published_revision ? store.revisions.get(story.id, story.published_revision) : null);
        if (!r) return null;
        const live = publication.liveSources(r);
        const snap = publication.snapshotOf(r);
        const upstream = stories.openUpstreamFlags(story);
        const sources = snap.map((s) => {
            const it = live.get(s.n);
            const removed = !it || it.status === 'removed';
            const changed = Boolean(it && !removed && it.sources_revision > s.sources_revision);
            const base = { n: s.n, outlet: s.outlet, status: removed ? 'removed' : 'active', upstream_changed: changed, perspective: s.perspective || null,
                sources_item: { service: 'sources', type: 'item', id: s.sources_item_id, revision: s.sources_revision } };
            if (removed && !editorView) return { ...base, removed_at: it && it.removed_at ? iso(it.removed_at) : null };
            return {
                ...base, headline: s.headline, url: s.url || null, authors: s.authors || [], published_at: s.published_at || null,
                retrieved_at: s.retrieved_at || null,
                // The licensed short summary, as snapshotted; never shown once the source is removed.
                summary: removed ? null : (s.summary || null),
                ...(editorView && removed ? { removed_reason: it ? it.removed_reason : 'missing' } : {}),
            };
        });
        const byN = new Map(sources.map((s) => [s.n, s]));
        const paragraphs = publication.paragraphsOf(r).map((p) => ({ text: p.text, sources: p.sources, supported: p.sources.some((n) => byN.get(n) && byN.get(n).status !== 'removed') }));
        const outletGroups = [];
        for (const s of sources) {
            let g = outletGroups.find((x) => x.outlet === s.outlet);
            if (!g) { g = { outlet: s.outlet, sources: [] }; outletGroups.push(g); }
            g.sources.push(s.n);
        }
        const rec = publication.authorshipOf(r);
        const review = publication.reviewOf(story, r);
        const authorSubjects = rec && Array.isArray(rec.authors) ? rec.authors : [];
        const who = authorSubjects.length ? await people.many(authorSubjects) : new Map();
        const authors = authorSubjects.map((s) => who.get(s)).filter((p) => p && p.known).map((p) => ({ name: p.name, username: p.username }));
        const topic = publication.topicOf(story);
        const flags = stories.publicFlags(story);
        const retraction = flags.find((f) => f.kind === 'retraction') || null;
        return {
            story, rev: r, topic,
            url: publication.storyUrl(story), path: publication.storyPath(story),
            headline: r.fields.headline,
            headline_sources: paragraphs[0] ? paragraphs[0].sources : [],
            paragraphs, sources, outletGroups,
            timeline: (r.fields.timeline || []).map((t) => ({ occurred_on: t.occurred_on, text: t.text, source: t.source, supported: Boolean(byN.get(t.source) && byN.get(t.source).status !== 'removed') })),
            perspectives: (r.fields.perspectives || []).map((p) => ({ label: p.label, description: p.description || null, sources: p.sources })),
            corrections: flags.filter((f) => f.kind !== 'retraction').map((f) => ({ kind: f.kind, note: f.note, revision: f.revision, at: iso(f.resolved_at || f.created_at) })),
            retraction: retraction ? { note: retraction.note, at: iso(retraction.resolved_at || retraction.created_at), revision: retraction.revision } : null,
            upstream: upstream.map((f) => {
                const s = snap.find((x) => x.id === f.source_item_id);
                return { kind: f.kind, n: s ? s.n : null, outlet: s ? s.outlet : null, at: iso(f.created_at) };
            }),
            authorship: rec, review, disclosure: rec ? disclosure(rec, review) : null, authors,
            decision: publication.decide(story, r),
            first_published_at: iso(story.first_published_at), updated_at: r.createdAt, published_at: iso(story.published_at),
        };
    }

    /** The .json twin of a story page: the same content, provenance and indexability. */
    function storyJson(m) {
        return {
            id: m.story.id, url: m.url, state: m.story.state, revision: m.rev.number,
            headline: m.headline, headline_sources: m.headline_sources,
            topic: m.topic ? { slug: m.topic.slug, name: m.topic.name, url: publication.abs(publication.topicPath(m.topic)) } : null,
            first_published_at: m.first_published_at, updated_at: m.updated_at,
            authorship: m.authorship ? { mode: m.authorship.mode, workflow: m.authorship.workflow ? m.authorship.workflow.id : null, reviewed_by_person: Boolean(m.review && m.review.decision === 'approved'), disclosure: m.disclosure ? m.disclosure.long : null } : null,
            authors: m.authors,
            claims: m.paragraphs.map((p) => ({ text: p.text, sources: p.sources, supported: p.supported })),
            sources: m.sources,
            timeline: m.timeline,
            perspectives: m.perspectives,
            corrections: m.corrections,
            retraction: m.retraction,
            pending_upstream_changes: m.upstream,
            indexability: { indexable: m.decision.indexable, robots: m.decision.robots, reasons: m.decision.reasons },
        };
    }

    /** schema.org NewsArticle from real fields only (openvibe-publishing/seo omits what is missing). */
    function storyJsonLd(m) {
        return seo.structuredData.article({
            type: 'NewsArticle', headline: m.headline, url: m.url,
            description: m.paragraphs[0] ? m.paragraphs[0].text.slice(0, 300) : undefined,
            datePublished: m.first_published_at || undefined, dateModified: m.updated_at || undefined,
            authors: m.authors.map((a) => ({ name: a.name })),
            publisher: { name: 'OpenVibe.News', url: config.baseUrl },
            section: m.topic ? m.topic.name : undefined, inLanguage: 'en',
            citations: m.sources.filter((s) => s.status !== 'removed' && s.url).map((s) => ({ url: s.url, title: s.headline })),
        });
    }

    /** Feed items for published (and retracted, labelled) stories: our own text only, never a source's. */
    async function feedItems({ topicId = null, limit = 30 } = {}) {
        const { stories: rows } = stories.listPublished({ topicId, limit });
        const out = [];
        for (const story of rows) {
            const m = await storyModel(story);
            if (!m) continue;
            out.push({
                id: publication.feedId(story), url: m.url,
                title: m.retraction ? `Retracted: ${m.headline}` : m.headline,
                summary: m.retraction ? `This story was retracted: ${m.retraction.note}` : (m.paragraphs[0] ? m.paragraphs[0].text : null),
                published: story.first_published_at, updated: m.updated_at,
                authors: m.authors.map((a) => ({ name: a.name })), tags: m.topic ? [m.topic.name] : [],
                decision: m.decision,
            });
        }
        return out;
    }

    /** Listing entries for the home and topic pages. */
    async function listItems(rows) {
        const out = [];
        for (const story of rows) {
            const r = store.revisions.get(story.id, story.published_revision);
            if (!r) continue;
            const paragraphs = publication.paragraphsOf(r);
            const topic = publication.topicOf(story);
            out.push({
                story, headline: r.fields.headline, url: publication.storyPath(story), lede: paragraphs[0] ? paragraphs[0].text : '',
                sourceCount: publication.snapshotOf(r).length, outlets: [...new Set(publication.snapshotOf(r).map((s) => s.outlet))].slice(0, 4),
                topic: topic ? { name: topic.name, url: publication.topicPath(topic) } : null, retracted: story.state === 'retracted',
                published_at: story.first_published_at, updated_at: r.createdAt,
            });
        }
        return out;
    }

    return { storyModel, storyJson, storyJsonLd, feedItems, listItems };
}

module.exports = { createReading };
