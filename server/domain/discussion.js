'use strict';

/**
 * Which stories have an open Community thread, and keeping the thread in step with the story.
 *
 * A story is open for discussion when it is published and no paragraph of its published revision
 * rests only on sources removed upstream. Indexability does not matter: a noindex story (a single
 * source, an editor's noindex) is public all the same.
 *   - a draft never gets a thread (Community threads are readable by anyone with the id)
 *   - retracted: the story stays on the record, its thread is hidden
 *   - unpublished: the page is gone (410), its thread is hidden
 *   - a paragraph resting only on a removed source: the thread is hidden until an editor publishes
 *     a revision that no longer rests on it (comments could repeat the withdrawn material)
 *
 * Writes that can change this call watch() inside their transaction, before they change anything.
 * After the commit (db.afterCommit; a rollback drops it) the state is compared again and, when it
 * changed, the thread is set hidden or public (best effort, community.comment.moderate). A rolled-back
 * write calls nothing; a story that never had a thread calls nothing either (threads are created only
 * when an open story is read).
 */
function createDiscussion({ store, publication, community, log = console }) {
    const { db } = store;
    const storyById = db.prepare('SELECT * FROM news_stories WHERE id = ?');
    const citing = db.prepare('SELECT DISTINCT story_id FROM news_story_sources WHERE source_item_id = ?');

    /** { open, reason: null | not_published | retracted | source_removed } */
    async function status(story) {
        if (!story || !story.published_revision) return { open: false, reason: 'not_published' };
        if (story.state === 'retracted') return { open: false, reason: 'retracted' };
        if (story.state !== 'published') return { open: false, reason: 'not_published' };
        const rev = await store.revisions.get(story.id, story.published_revision);
        if (!rev) return { open: false, reason: 'not_published' };
        if ((await publication.support(rev)).unsupported > 0) return { open: false, reason: 'source_removed' };
        return { open: true, reason: null };
    }

    let flushing = Promise.resolve();   // visibility calls go one at a time, in commit order

    async function follow(id, was) {
        const now = (await status(await storyById.get(id))).open;
        if (now !== was) await community.setThreadVisibility(id, now ? 'public' : 'hidden');
    }

    /** Remember whether a story is open now; after the commit, follow any change. Inside the write's transaction. */
    async function watch(storyId) {
        if (!community.enabled) return;
        const was = (await status(await storyById.get(storyId))).open;
        db.afterCommit(() => { flushing = flushing.then(() => follow(storyId, was)).catch((err) => log.warn(`[News] comment thread sync failed: ${err.message}`)); });
    }

    return {
        status,
        watch,
        /** Every story that cites a source item (before the item changes upstream). */
        async watchSource(itemId) { for (const r of await citing.all(itemId)) await watch(r.story_id); },
        /** Resolves once the scheduled visibility changes have been sent (tests, shutdown). */
        idle: () => new Promise((resolve) => setImmediate(() => flushing.then(resolve))),
    };
}

module.exports = { createDiscussion };
