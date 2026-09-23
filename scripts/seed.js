#!/usr/bin/env node
'use strict';
/**
 * Seed OpenVibe.News: topics only (seeds/topics.json). Idempotent — missing topics are added,
 * existing ones are never renamed, re-described or re-activated. There are no seed stories,
 * source items or clusters: News publishes nothing until an editor does.
 *
 *   npm run seed            (uses NEWS_DB_PATH from .env or /etc/openvibe/news.env)
 */
require('dotenv').config();
const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createTopics } = require('../server/domain/topics');

const config = load();
const store = openStore(config.dbPath);
const r = createTopics({ store }).seed();
console.log(`topics: ${r.created} added, ${r.existing} already present (${config.dbPath})`);
store.close();
