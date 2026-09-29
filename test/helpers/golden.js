'use strict';
/**
 * The ingest golden fixture: a deterministic Sources feed and the canonical projection of the
 * domain rows it produces (news_source_items + news_story_clusters + a removed item's live state).
 * The same fixture and the same projection run before and after the chassis conversion, so
 * test/chassis.test.js can compare the projection to test/fixtures/ingest-golden.json (captured
 * from the pre-conversion code). Volatile values (ULID ids, cluster ids) are mapped to their stable
 * Sources item ids, so only domain meaning is compared.
 */
const { launchReports } = require('./boot');

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Add the fixture's items to the Sources mock (same order and fields as the capture run). → reports */
function feedFixture(t) {
    const reports = launchReports(t.sources);
    t.sources.addItem({ source_key: 'blog-x', category: 'blog', title: 'A blog item that News must ignore' });
    t.sources.addItem({ source_key: 'paper-b', title: 'Europa Clipper launch: our live coverage', url: 'https://www.wire-a.example/space/europa-clipper-launch/?utm_source=x', published_at: '2026-09-22T11:00:00Z' });
    t.sources.addItem({ source_key: 'site-c', title: 'Syndicated copy', url: 'https://mirror.example/copy', content_hash: reports.b.provenance.content_hash });
    t.sources.addItem({ source_key: 'wire-a', title: 'NASA launches Europa Clipper probe to Jupiter moon Europa, officials say', url: 'https://wire-a.example/space/europa-clipper-launch-updated', published_at: '2026-09-22T12:00:00Z' });
    t.sources.addItem({ source_key: 'paper-b', title: 'City council approves new bike lanes downtown', url: 'https://paper-b.example/bike-lanes', published_at: '2026-09-22T12:00:00Z' });
    t.sources.addItem({ source_key: 'wire-a', title: '' });
    return reports;
}

/** A revision upstream (title change) and a removal, applied by a second pull. */
function reviseFixture(t, reports) {
    t.sources.updateItem(reports.c.id, { title: 'Why NASA is sending Europa Clipper to Jupiter, explained' });
    t.sources.removeItem(reports.b.id, 'licence review');
}

/** The canonical projection of the domain rows. Deterministic in everything but ids. → { items, clusters } */
async function project(t) {
    const db = t.db();
    const items = await db.prepare('SELECT * FROM news_source_items ORDER BY sources_item_id').all();
    const srcOf = new Map(items.map((r) => [r.id, r.sources_item_id]));
    const membersByCluster = new Map();
    for (const r of items) {
        if (!r.cluster_id) continue;
        if (!membersByCluster.has(r.cluster_id)) membersByCluster.set(r.cluster_id, []);
        membersByCluster.get(r.cluster_id).push(r.sources_item_id);
    }
    const clusterIndex = new Map([...membersByCluster.entries()]
        .map(([id, ms]) => [id, ms.slice().sort()[0]])
        .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        .map(([id], i) => [id, i + 1]));
    const clusters = await db.prepare('SELECT * FROM news_story_clusters ORDER BY id').all();
    return {
        items: items.map((r) => ({
            sources_item_id: r.sources_item_id, sources_revision: r.sources_revision, source_key: r.source_key,
            canonical_url: r.canonical_url, url_key: r.url_key, headline: r.headline, outlet: r.outlet,
            authors: r.authors, published_at: r.published_at, summary: r.summary, summary_basis: r.summary_basis,
            license_note: r.license_note, terms_note: r.terms_note, content_hash: r.content_hash, title_key: r.title_key,
            status: r.status, dedupe_rule: r.dedupe ? parse(r.dedupe, {}).rule : null,
            duplicate_of: r.duplicate_of ? (srcOf.get(r.duplicate_of) || null) : null,
            cluster: r.cluster_id ? clusterIndex.get(r.cluster_id) : null,
            cluster_reason_rule: r.cluster_reason ? parse(r.cluster_reason, {}).rule : null,
            retrieved_at: r.retrieved_at, first_seen_at: r.first_seen_at, updated_at: r.updated_at,
            removed_at: r.removed_at || null, removed_reason: r.removed_reason || null,
        })),
        clusters: [...membersByCluster.entries()]
            .sort((a, b) => clusterIndex.get(a[0]) - clusterIndex.get(b[0]))
            .map(([id, ms]) => {
                const c = clusters.find((x) => x.id === id) || {};
                return { index: clusterIndex.get(id), label: c.label || null, status: c.status || null, terms: c.terms || null, entities: c.entities || null, window_start: c.window_start || null, window_end: c.window_end || null, members: ms.slice().sort() };
            }),
    };
}

module.exports = { feedFixture, reviseFixture, project };
