'use strict';
/**
 * Regroup open clusters with today's rule (clusters.resplit): each cluster's reports are grouped on its core terms
 * again, and every group but the first report's is split off as an audited, reversible split (actor svc:news).
 * Clusters built before 2026-10-15 matched on the union of their reports' words and could take unrelated reports.
 *
 *   node scripts/resplit-clusters.js                 # dry run: what would split, nothing changes
 *   node scripts/resplit-clusters.js --apply         # split
 *   node scripts/resplit-clusters.js clu_… [--apply] # only these clusters
 *
 * The events (news.cluster.updated) wait in the outbox; the running service's relay sends them.
 */
require('dotenv').config();
const { createServiceOutbox } = require('openvibe-sdk/events');
const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createClusters } = require('../server/domain/clusters');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.filter((a) => /^clu_/.test(a));
const config = load();
(async () => {
    const store = await openStore(config);
    const outbox = createServiceOutbox({ db: store.db, source: 'news', log: { log() {}, warn() {}, error: console.error }, now: store.now });
    const clusters = createClusters({ store, config, outbox });
    const ids = only.length ? only : (await clusters.recent({ limit: 1000 })).map((c) => c.id);
    let split = 0;
    for (const id of ids) {
        const r = await clusters.resplit(null, id, { dryRun: !apply });
        if (r.groups < 2) continue;
        split += r.groups - 1;
        const headline = async (itemId) => (await store.db.prepare('SELECT headline FROM news_source_items WHERE id = ?').get(itemId) || {}).headline;
        console.log(`${id}: ${r.grouping.reduce((n, g) => n + g.length, 0)} reports → ${r.groups} groups${apply ? ` (split audits ${r.splits.map((a) => a.id).join(', ')})` : ''}`);
        for (const g of r.grouping.slice(0, 12)) console.log(`   ${String(g.length).padStart(3)}  ${String(await headline(g[0])).slice(0, 100)}`);
        if (r.grouping.length > 12) console.log(`   … ${r.grouping.length - 12} more groups`);
    }
    console.log(`${apply ? 'split off' : 'would split off'} ${split} group(s) from ${ids.length} open cluster(s)`);
    await store.close();
})().catch((err) => { console.error(`[resplit] ${err.message}`); process.exit(1); });
