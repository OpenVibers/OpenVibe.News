'use strict';

/**
 * Topics: canonical topic identities (slug → name). The seed (seeds/topics.json) is the only data
 * News seeds; it inserts missing topics and never renames, re-describes or archives an existing one.
 * Editors may add topics (news.topic.manage).
 */
const fs = require('fs');
const path = require('path');
const { ids } = require('openvibe-contracts');
const { slugify } = require('openvibe-publishing/taxonomy');
const { ApiError } = require('../http/errors');

const SEED_FILE = path.join(__dirname, '..', '..', 'seeds', 'topics.json');

function createTopics({ store }) {
    const { db } = store;
    const q = {
        bySlug: db.prepare('SELECT * FROM news_topics WHERE slug = ?'),
        byId: db.prepare('SELECT * FROM news_topics WHERE id = ?'),
        active: db.prepare("SELECT * FROM news_topics WHERE status = 'active' ORDER BY name"),
        insert: db.prepare('INSERT INTO news_topics (id, slug, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'active\', ?, ?)'),
    };

    function create({ slug, name, description = null }) {
        const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!n) throw new ApiError(422, 'topic.no_name', 'A topic needs a name');
        let s;
        try { s = slugify(slug || n).slice(0, 60); } catch { throw new ApiError(422, 'topic.invalid_slug', 'That name has no letters or digits to make a URL from'); }
        if (q.bySlug.get(s)) return { topic: q.bySlug.get(s), created: false };
        const now = store.now();
        const id = `top_${ids.ulid(now)}`;
        q.insert.run(id, s, n, description ? String(description).replace(/\s+/g, ' ').trim().slice(0, 300) : null, now, now);
        return { topic: q.byId.get(id), created: true };
    }

    return {
        create,
        list: () => q.active.all(),
        bySlug: (slug) => q.bySlug.get(String(slug || '')) || null,
        byId: (id) => q.byId.get(String(id || '')) || null,
        /** Insert the seeded topics that are missing. → { created, existing } */
        seed(file = SEED_FILE) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            let created = 0;
            let existing = 0;
            store.tx(() => {
                for (const t of data.topics || []) {
                    const r = create(t);
                    if (r.created) created++; else existing++;
                }
            });
            return { created, existing };
        },
    };
}

module.exports = { createTopics, SEED_FILE };
