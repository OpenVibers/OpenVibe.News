#!/usr/bin/env node
'use strict';
/**
 * Seed OpenVibe.News: topics only (seeds/topics.json). Idempotent — missing topics are added,
 * existing ones are never renamed, re-described or re-activated. There are no seed stories,
 * source items or clusters: News publishes nothing until an editor does.
 *
 *   npm run seed            (DATABASE_URL from .env or /etc/openvibe/news.env; without it, the development PGlite)
 */
require('dotenv').config();
const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createTopics } = require('../server/domain/topics');

const config = load();
(async () => {
    const store = await openStore(config);
    const r = await createTopics({ store }).seed();
    console.log(`topics: ${r.created} added, ${r.existing} already present (${store.db.store})`);
    await store.close();
})().catch((err) => { console.error(`[seed] ${err.message}`); process.exit(1); });
