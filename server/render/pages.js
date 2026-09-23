'use strict';

/**
 * Public pages (HTML bodies; layout.js wraps them). Everything a reader needs is in the HTML: the
 * text with its source numbers, the source table (factual fields from the sources, kept apart from
 * the editors' text), the timeline, perspectives, the correction history and any retraction or
 * upstream-change notice, then the story's OpenVibe.Community thread with a plain comment form.
 * Values are escaped by ssr.html unless wrapped in raw().
 */
const ssr = require('openvibe-publishing/ssr');

const { html: h, raw } = ssr;

const dateLabel = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const time = (v) => raw(ssr.timeTag(v == null ? null : new Date(v).toISOString(), { label: dateLabel(v) || undefined }));
const cites = (ns) => h`<sup class="cites">${ns.map((n, i) => h`${i ? ',' : ''}<a href="#source-${n}" aria-label="source ${n}">${n}</a>`)}</sup>`;

function storyListItem(it) {
    return h`<li class="story-item${it.retracted ? ' retracted' : ''}">
<h2 class="story-item-title"><a href="${it.url}">${it.headline}</a>${it.retracted ? h` <span class="badge badge-retracted">Retracted</span>` : ''}</h2>
<p class="meta">${time(it.published_at)}${it.topic ? h` · <a href="${it.topic.url}">${it.topic.name}</a>` : ''} · ${it.sourceCount} ${it.sourceCount === 1 ? 'source' : 'sources'}${it.outlets.length ? h` (${it.outlets.join(', ')})` : ''}</p>
${it.lede ? h`<p class="summary">${it.lede}</p>` : ''}
</li>`;
}

function storyList(items, empty) {
    if (!items.length) return h`<p class="empty">${empty}</p>`;
    return h`<ol class="story-list">${items.map(storyListItem)}</ol>`;
}

function feedLinksHtml(feeds) {
    if (!feeds.length) return '';
    return h`<p class="feeds">Follow: ${feeds.map((f) => h`<a href="${f.href}">${f.label}</a> `)}</p>`;
}

function home({ items, pager, topics, feeds }) {
    return String(h`<header class="site-header">
<h1>OpenVibe.News</h1>
<p class="lede">Source-backed stories. Every paragraph cites the reports it rests on; corrections and retractions stay on the record.</p>
${raw(feedLinksHtml(feeds))}
</header>
<section aria-label="Stories">${storyList(items, 'No stories have been published yet. OpenVibe.News publishes only what an editor has written from its sources.')}</section>
${raw(ssr.paginationHtml(pager))}
${topics.length ? h`<section class="side" aria-label="Topics"><h2>Topics</h2><ul class="topic-list">${topics.map((t) => h`<li><a href="/topics/${t.slug}">${t.name}</a></li>`)}</ul></section>` : ''}`);
}

function topicsIndex({ topics }) {
    return String(h`<header class="site-header"><h1>Topics</h1></header>
<ul class="topic-list wide">${topics.map((t) => h`<li><a href="/topics/${t.slug}">${t.name}</a>${t.description ? h` <span class="meta">— ${t.description}</span>` : ''}</li>`)}</ul>`);
}

function topicPage({ topic, items, pager, feeds, breadcrumbs }) {
    return String(h`${raw(ssr.breadcrumbsHtml(breadcrumbs))}
<header class="site-header"><h1>${topic.name}</h1>${topic.description ? h`<p class="lede">${topic.description}</p>` : ''}${raw(feedLinksHtml(feeds))}</header>
<section aria-label="Stories">${storyList(items, `No stories on ${topic.name} have been published yet.`)}</section>
${raw(ssr.paginationHtml(pager))}`);
}

function sourceRow(s) {
    if (s.status === 'removed' && !s.headline) {
        return h`<tr id="source-${s.n}" class="removed"><td>${s.n}</td><td colspan="4"><strong>${s.outlet}</strong> — this source was removed by the source registry${s.removed_at ? h` on ${time(Date.parse(s.removed_at))}` : ''}. Its headline, summary and link are no longer shown.</td></tr>`;
    }
    return h`<tr id="source-${s.n}"${s.upstream_changed ? raw(' class="changed"') : ''}>
<td>${s.n}</td>
<td>${s.url ? h`<a href="${s.url}" rel="noopener nofollow">${s.headline}</a>` : s.headline}${s.summary ? h`<p class="source-summary">${s.summary}</p>` : ''}${s.upstream_changed ? h`<p class="notice small">The source changed after this revision; editors are checking it.</p>` : ''}${s.status === 'removed' ? h`<p class="notice small">Removed upstream${s.removed_reason ? h`: ${s.removed_reason}` : ''}.</p>` : ''}</td>
<td>${s.outlet}</td>
<td>${s.authors && s.authors.length ? s.authors.join(', ') : raw('<span class="meta">not stated</span>')}</td>
<td>${s.published_at ? time(Date.parse(s.published_at)) : raw('<span class="meta">not stated</span>')}</td>
</tr>`;
}

function sourceTable(m, group) {
    const table = (rows) => h`<table class="sources"><thead><tr><th scope="col">#</th><th scope="col">Headline (as published by the source)</th><th scope="col">Outlet</th><th scope="col">Author</th><th scope="col">Published</th></tr></thead><tbody>${rows.map(sourceRow)}</tbody></table>`;
    const byN = new Map(m.sources.map((s) => [s.n, s]));
    const tabs = h`<p class="framing">Group sources by: ${['number', 'outlet', 'perspective'].map((g) => (g === group ? h`<strong>${g}</strong> ` : h`<a href="?group=${g}#sources" rel="nofollow">${g}</a> `))}</p>`;
    if (group === 'outlet') {
        return h`${tabs}${m.outletGroups.map((g) => h`<h3>${g.outlet}</h3>${table(g.sources.map((n) => byN.get(n)))}`)}`;
    }
    if (group === 'perspective') {
        if (!m.perspectives.length) return h`${tabs}<p class="empty">Editors have not grouped these sources into perspectives.</p>${table(m.sources)}`;
        const grouped = new Set(m.perspectives.flatMap((p) => p.sources));
        const rest = m.sources.filter((s) => !grouped.has(s.n));
        return h`${tabs}<p class="meta">Perspective labels are written by OpenVibe.News editors; they describe how the sources are grouped, not a verdict.</p>
${m.perspectives.map((p) => h`<h3>${p.label}</h3>${p.description ? h`<p>${p.description}</p>` : ''}${p.sources.length ? table(p.sources.map((n) => byN.get(n))) : h`<p class="empty">No sources in this group.</p>`}`)}
${rest.length ? h`<h3>Not grouped</h3>${table(rest)}` : ''}`;
    }
    return h`${tabs}${table(m.sources)}`;
}

const CLOSED = {
    retracted: 'Comments are closed: this story was retracted.',
    source_removed: 'Comments are paused while editors revise this story: a source it rests on was removed.',
    not_published: 'Comments are available on published stories only.',
};

/** The Community thread (read from Community on this render), or why there is none. */
function commentsSection(c, { path, csrf, signedIn, loginUrl }) {
    const wrap = (inner) => String(h`<section id="comments" class="comments" aria-labelledby="comments-h"><h2 id="comments-h">Comments</h2>${raw(String(inner))}</section>`);
    if (c.state === 'closed') return wrap(h`<p class="empty">${CLOSED[c.reason] || CLOSED.not_published}</p>`);
    if (c.state === 'off') return wrap(h`<p class="empty">Comments are not connected on this server.</p>`);
    if (c.state !== 'ok') return wrap(h`<p class="notice" role="status">Comments are unavailable: they could not be loaded from OpenVibe.Community right now. Reload later.</p>`);
    const one = (x) => h`<li class="comment" id="comment-${x.id}">
<p class="meta"><strong>${x.deleted ? '[deleted]' : (x.display_name || 'Anonymous')}</strong>${x.origin === 'ai' ? h` <span class="badge">AI</span>` : ''}${Number.isFinite(Date.parse(x.created_at)) ? h` · ${time(Date.parse(x.created_at))}` : ''}</p>
${x.deleted ? h`<p class="empty">This comment was deleted.</p>` : raw(`<p>${ssr.escapeHtml(String(x.message || '')).replace(/\n/g, '<br>')}</p>`)}
${x.replies && x.replies.length ? h`<ol class="replies">${x.replies.map(one)}</ol>` : ''}
</li>`;
    const list = c.comments.length ? h`<ol class="comment-list">${c.comments.map(one)}</ol>` : h`<p class="empty">No comments yet.</p>`;
    const more = c.nextCursor ? h`<p><a href="${path}?comments_after=${c.nextCursor}#comments" rel="nofollow">More comments</a></p>` : '';
    const form = c.thread && c.thread.visibility === 'locked'
        ? h`<p class="empty">This thread is locked.</p>`
        : signedIn
            ? h`<form method="post" action="${path}/comments" class="comment-form">
<input type="hidden" name="_csrf" value="${csrf}">
<label for="comment-message">Add a comment</label>
<textarea id="comment-message" name="message" rows="4" maxlength="5000" required></textarea>
<button type="submit">Post comment</button>
</form>`
            : h`<p><a href="${loginUrl}">Sign in with OpenVibe</a> to comment.</p>`;
    return wrap(h`<p class="meta">Comments are hosted by <a href="${c.communityUrl}">OpenVibe.Community</a>.</p>${list}${more}${form}`);
}

/** One story. */
function storyPage(m, { group = 'number', breadcrumbs, jsonUrl, editUrl = null, decisionNote = null, comments = null, signedIn = false, csrf = '', loginUrl = '/auth/login' }) {
    const notices = [];
    if (m.retraction) notices.push(h`<div class="retraction" role="alert"><h2>Retracted</h2><p>${m.retraction.note}</p><p class="meta">Retracted ${time(Date.parse(m.retraction.at))}. The story is kept here for the record and is not offered to search engines.</p></div>`);
    for (const u of m.upstream) {
        notices.push(h`<p class="notice" role="status">${u.kind === 'source_removed'
            ? h`Source ${u.n ? `[${u.n}]` : ''} (${u.outlet || 'a source'}) was removed by the source registry after publication. Editors are reviewing this story.`
            : h`Source ${u.n ? `[${u.n}]` : ''} (${u.outlet || 'a source'}) changed after publication. Editors are checking whether the text needs a correction.`}</p>`);
    }
    return String(h`${raw(ssr.breadcrumbsHtml(breadcrumbs))}
<article class="story" data-story-id="${m.story.id}" data-revision="${m.rev.number}">
<header>
${raw(notices.join(''))}
<h1>${m.headline}</h1>
<p class="byline">${m.authors.length ? h`By ${m.authors.map((a) => a.name).join(', ')} · ` : ''}OpenVibe.News${m.first_published_at ? h` · ${time(Date.parse(m.first_published_at))}` : ''}${m.rev.number > 1 && m.first_published_at && Date.parse(m.updated_at) > Date.parse(m.first_published_at) + 60000 ? h` · updated ${time(Date.parse(m.updated_at))}` : ''}${m.topic ? h` · <a href="/topics/${m.topic.slug}">${m.topic.name}</a>` : ''}${m.story.state !== 'published' && m.story.state !== 'retracted' ? h` <span class="badge">${m.story.state}</span>` : ''}</p>
${m.disclosure ? h`<p class="disclosure" role="note"><strong>${m.disclosure.short}.</strong> ${m.disclosure.long}</p>` : ''}
</header>
<div class="story-body">${m.paragraphs.map((p) => h`<p${p.supported ? '' : raw(' class="unsupported"')}>${p.text} ${cites(p.sources)}${p.supported ? '' : h` <span class="badge">source removed</span>`}</p>`)}</div>
<p class="meta">Numbers in brackets point to the sources below. Headlines, outlets, authors and dates in the table are as each source published them; the text above is written by OpenVibe.News.</p>
${m.timeline.length ? h`<section class="timeline" aria-labelledby="timeline-h"><h2 id="timeline-h">Timeline</h2><ol>${m.timeline.map((t) => h`<li><time datetime="${t.occurred_on}">${t.occurred_on.slice(0, 10)}</time> — ${t.text} ${cites([t.source])}</li>`)}</ol></section>` : ''}
<section id="sources" class="source-table" aria-labelledby="sources-h"><h2 id="sources-h">Sources</h2>${sourceTable(m, group)}</section>
${m.perspectives.length && group !== 'perspective' ? h`<section class="perspectives" aria-labelledby="persp-h"><h2 id="persp-h">Perspectives</h2><p class="meta">Groupings by OpenVibe.News editors.</p><ul>${m.perspectives.map((p) => h`<li><strong>${p.label}</strong>${p.description ? h` — ${p.description}` : ''} ${p.sources.length ? cites(p.sources) : ''}</li>`)}</ul></section>` : ''}
<section class="corrections" aria-labelledby="corr-h"><h2 id="corr-h">Corrections and updates</h2>
${m.corrections.length || m.retraction ? h`<ol>${m.corrections.map((c) => h`<li><strong>${c.kind === 'correction' ? 'Correction' : 'Update'}</strong> (${time(Date.parse(c.at))}, revision ${c.revision}): ${c.note}</li>`)}${m.retraction ? h`<li><strong>Retraction</strong> (${time(Date.parse(m.retraction.at))}): ${m.retraction.note}</li>` : ''}</ol>` : h`<p class="empty">None.</p>`}
</section>
<footer class="story-footer"><p class="meta">Revision ${m.rev.number}${decisionNote ? h` · ${decisionNote}` : ''} · <a href="${jsonUrl}">JSON</a>${editUrl ? h` · <a href="${editUrl}">Edit</a>` : ''}</p></footer>
</article>
${raw(comments ? commentsSection(comments, { path: m.path, csrf, signedIn, loginUrl }) : '')}`);
}

function message({ heading, text, action }) {
    return String(h`<section class="message"><h1>${heading}</h1><p>${text}</p>${action ? h`<p><a class="button" href="${action.href}">${action.label}</a></p>` : ''}</section>`);
}

module.exports = { home, topicsIndex, topicPage, storyPage, commentsSection, message, storyList, time, dateLabel, cites };
