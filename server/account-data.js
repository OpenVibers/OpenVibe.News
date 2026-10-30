'use strict';
/**
 * Account export and deletion → News (ADR-033; openvibe-sdk/account-data).
 *
 * A person's private working rows go: their story drafts (news_story_drafts.owner) and the cached profile
 * (subject_projections). Their editorial contribution to a story — the story, a perspective, a timeline entry, a
 * cluster, an editorial flag — stays: it is the publication's record, and a byline is part of what readers are owed;
 * those rows are exported and kept, with created_by as the editorial attribution. Telemetry samples that name a
 * person are covered by the SDK itself.
 *
 * news_index_revisions.owner is the index document's owning service, not a person.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const editorial = (why) => ({ keep: why });

const TABLES = [
    { table: 'news_story_drafts', subject: 'owner', file: 'story-drafts.json', order: 'updated_at', columns: ['entity_id', 'base_revision', 'content', 'fields', 'created_at', 'updated_at'] },
    { table: 'subject_projections', subject: 'subject', file: 'profile.json', order: 'refreshed_at' },
    { table: 'news_stories', subject: 'created_by', file: 'stories.json', order: 'first_published_at', columns: ['id', 'slug', 'working_headline', 'topic_id', 'state', 'first_published_at', 'published_at'], erase: editorial('published journalism keeps its editor byline as the publication record') },
    { table: 'news_perspectives', subject: 'created_by', file: 'perspectives.json', order: 'created_at', columns: ['id', 'story_id', 'label', 'description', 'position', 'created_at'], erase: editorial('a published perspective is part of the story') },
    { table: 'news_timeline_entries', subject: 'created_by', file: 'timeline-entries.json', order: 'created_at', columns: ['id', 'story_id', 'occurred_on', 'text', 'created_at'], erase: editorial('a published timeline entry is part of the story') },
    { table: 'news_story_clusters', subject: 'created_by', file: 'story-clusters.json', order: 'window_start', columns: ['id', 'label', 'status', 'window_start', 'window_end'], erase: editorial('a story cluster is the newsroom\'s record') },
    { table: 'news_editorial_flags', subject: 'created_by', file: 'editorial-flags.json', order: 'created_at', columns: ['id', 'story_id', 'kind', 'status', 'note', 'created_at'], erase: editorial('a correction, update or retraction is the record readers rely on') },
    // The edit history of a story: the publication's record of how the story was written, with its byline.
    { table: 'news_story_revisions', subject: 'author', file: 'story-revisions.json', order: 'created_at', columns: ['id', 'entity_id', 'number', 'kind', 'message', 'created_at'], erase: editorial('a published story keeps its edit history and byline as the publication record') },
];

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'news', tables: TABLES, log });
}

module.exports = { create, TABLES, TOPICS };
