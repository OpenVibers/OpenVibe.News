'use strict';

/**
 * The editor desk as plain HTML forms that work without JavaScript. Every form posts to the same
 * origin with the per-session form token (_csrf); sign-in is Network SSO; every page is private,
 * no-store and noindex.
 */
const ssr = require('openvibe-publishing/ssr');
const { time } = require('./pages');

const { html: h, raw } = ssr;
const csrfField = (csrf) => h`<input type="hidden" name="_csrf" value="${csrf}">`;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const STATE_LABEL = { draft: 'Draft', published: 'Published', unpublished: 'Unpublished', retracted: 'Retracted' };

function flash(msg) {
    if (!msg) return '';
    return h`<p class="notice ${msg.kind === 'error' ? 'error' : ''}" role="${msg.kind === 'error' ? 'alert' : 'status'}">${msg.text}</p>`;
}

function select(name, options, current) {
    return h`<select id="${name}" name="${name}">${options.map(([v, label]) => (v === current ? h`<option value="${v}" selected>${label}</option>` : h`<option value="${v}">${label}</option>`))}</select>`;
}

function topicSelect(topics, current, name = 'topic') {
    return select(name, [['', '— no topic —'], ...topics.map((t) => [t.slug, t.name])], current || '');
}

function why(reason) {
    const r = parse(reason, null);
    if (!r) return '';
    if (r.rule === 'shared_terms') return `shares ${r.shared_entities.length ? `entities ${r.shared_entities.join(', ')}; ` : ''}terms ${r.shared_terms.join(', ')} (score ${r.score}, ${r.window_hours} h window)`;
    if (r.rule === 'new_cluster') return `started this cluster (terms ${r.terms.slice(0, 8).join(', ')})`;
    if (r.rule === 'duplicate_of') return `duplicate of ${r.item}`;
    return r.rule + (r.from ? ` from ${r.from}` : '');
}

function dashboard({ clusters, stories, flags, runs, sources, cursor, csrf, message, aiEnabled, pullOn }) {
    return String(h`<h1>Editor desk</h1>
${flash(message)}
<p class="meta">Stories are written by editors from source items. Nothing is published until an editor publishes it${aiEnabled ? '; AI drafts wait for a person’s review' : ''}.</p>
<section><h2>Open flags</h2>${flags.length ? h`<ul>${flags.map((f) => h`<li><a href="/edit/stories/${f.story_id}">${f.working_headline}</a> — ${f.kind.replace('_', ' ')}${f.pending_revision ? h` (pending revision ${f.pending_revision})` : ''} · ${time(f.created_at)}</li>`)}</ul>` : h`<p class="empty">None.</p>`}</section>
<section><h2>Stories</h2>${stories.length ? h`<table><thead><tr><th>Headline</th><th>State</th><th>Revision</th><th>Updated</th></tr></thead><tbody>${stories.map((s) => h`<tr><td><a href="/edit/stories/${s.id}">${s.working_headline}</a></td><td>${STATE_LABEL[s.state]}</td><td>${s.published_revision || '—'}</td><td>${time(s.updated_at)}</td></tr>`)}</tbody></table>` : h`<p class="empty">No stories yet. Open one from a cluster below.</p>`}</section>
<section><h2>Recent clusters</h2>${clusters.length ? h`<table><thead><tr><th>Cluster</th><th>Items</th><th>Latest</th></tr></thead><tbody>${clusters.map((c) => h`<tr><td><a href="/clusters/${c.id}">${c.label}</a></td><td>${c.count}</td><td>${time(c.window_end)}</td></tr>`)}</tbody></table>` : h`<p class="empty">No source items have arrived yet.</p>`}</section>
<section><h2>Ingestion</h2>
<p class="meta">Cursor ${cursor} · cursor pull ${pullOn ? 'on' : 'off'}.</p>
${sources.length ? h`<table><thead><tr><th>Source</th><th>Name</th><th>Status</th><th>Last success</th></tr></thead><tbody>${sources.map((s) => h`<tr><td>${s.source_key}</td><td>${s.name || '—'}</td><td>${s.status || 'unknown'}${s.stale ? ' (stale)' : ''}</td><td>${s.last_success_at || '—'}</td></tr>`)}</tbody></table>` : ''}
${runs.length ? h`<table><thead><tr><th>When</th><th>Origin</th><th>State</th><th>Detail</th></tr></thead><tbody>${runs.map((r) => h`<tr><td>${time(r.at)}</td><td>${r.origin}</td><td>${r.state}</td><td>${r.source_key || ''} ${r.sources_item_id || ''} ${r.error_code || ''} ${r.detail || ''}${r.counts ? ` ${r.counts}` : ''}</td></tr>`)}</tbody></table>` : h`<p class="empty">Nothing ingested yet.</p>`}
<form method="post" action="/edit/pull">${csrfField(csrf)}<button type="submit">Pull from OpenVibe.Sources now</button></form>
</section>
<p><a href="/edit/topics">Topics</a></p>`);
}

function clusterPage({ cluster, items, audit, others, storiesOf, topics, csrf, message }) {
    const open = cluster.status === 'open';
    return String(h`<p><a href="/edit">← Editor desk</a></p>
<h1>Cluster: ${cluster.label}</h1>
${flash(message)}
<p class="meta">${cluster.id} · ${cluster.status}${cluster.merged_into ? h` into <a href="/clusters/${cluster.merged_into}">${cluster.merged_into}</a>` : ''}${cluster.split_from ? h` · split from <a href="/clusters/${cluster.split_from}">${cluster.split_from}</a>` : ''} · items grouped by shared named entities and terms within a time window; every membership says why.</p>
<form method="post" action="/clusters/${cluster.id}/split">${csrfField(csrf)}
<table><thead><tr><th>Split</th><th>Headline</th><th>Outlet</th><th>Published</th><th>Status</th><th>Why here</th></tr></thead><tbody>
${items.map((it) => h`<tr><td>${open ? h`<input type="checkbox" name="items" value="${it.id}" aria-label="split ${it.headline}">` : ''}</td><td>${it.canonical_url ? h`<a href="${it.canonical_url}" rel="noopener nofollow">${it.headline}</a>` : it.headline}<br><span class="meta">${it.id} · Sources ${it.sources_item_id} r${it.sources_revision}</span></td><td>${it.outlet}</td><td>${it.published_at ? it.published_at.slice(0, 10) : 'not stated'}</td><td>${it.status}${it.dedupe ? h`<br><span class="meta">${parse(it.dedupe, {}).rule}: ${parse(it.dedupe, {}).detail}</span>` : ''}${it.removed_reason ? h`<br><span class="meta">${it.removed_reason}</span>` : ''}</td><td class="meta">${why(it.cluster_reason)}</td></tr>`)}
</tbody></table>
${open ? h`<label for="split-reason">Reason for the split</label><input id="split-reason" name="reason" maxlength="500"><button type="submit">Split the ticked items into a new cluster</button>` : ''}
</form>
${open ? h`<section class="card"><h2>Merge another cluster into this one</h2><form method="post" action="/clusters/${cluster.id}/merge">${csrfField(csrf)}
<label for="other">Cluster</label>${select('other', others.map((o) => [o.id, `${o.label} (${o.id})`]), '')}
<label for="merge-reason">Reason</label><input id="merge-reason" name="reason" maxlength="500">
<button type="submit">Merge</button></form></section>` : ''}
<section><h2>History</h2>${audit.length ? h`<ul>${audit.map((a) => h`<li>${a.action.replace('_', ' ')} · ${a.cluster_id} ⇄ ${a.other_id} · ${a.item_ids.length} items · ${a.actor}${a.reason ? h` — ${a.reason}` : ''}${a.reversed_by ? h` · reversed by ${a.reversed_by}` : ''}${!a.reversed_by && (a.action === 'merge' || a.action === 'split') ? h` <form class="inline" method="post" action="/clusters/audit/${a.id}/reverse">${csrfField(csrf)}<button type="submit">Reverse</button></form>` : ''}</li>`)}</ul>` : h`<p class="empty">No merges or splits.</p>`}</section>
<section><h2>Stories from this cluster</h2>${storiesOf.length ? h`<ul>${storiesOf.map((s) => h`<li><a href="/edit/stories/${s.id}">${s.working_headline}</a> (${s.state})</li>`)}</ul>` : h`<p class="empty">None yet.</p>`}
${open ? h`<form method="post" action="/clusters/${cluster.id}/stories" class="card">${csrfField(csrf)}
<h3>Open a story</h3><p class="meta">The cluster's live, non-duplicate items become the first sources [1], [2], … You write the headline and text.</p>
<label for="headline">Working headline</label><input id="headline" name="headline" maxlength="200" required>
<label for="topic">Topic</label>${topicSelect(topics, '')}
<button type="submit">Open the story</button></form>` : ''}</section>`);
}

function storyEditor({ story, head, problems, sources, timeline, perspectives, flags, revisions, topics, topic, csrf, message, aiEnabled, publicUrl, decision }) {
    const body = head ? head.fields.paragraphs.map((p) => `${p.text} [${p.sources.join(', ')}]`).join('\n\n') : '';
    const rec = head && head.meta.authorship;
    const needsReview = rec && (rec.mode === 'ai' || rec.mode === 'hybrid');
    const openFlags = flags.filter((f) => f.status === 'open');
    const live = sources.filter((s) => !s.detached_at);
    return String(h`<p><a href="/edit">← Editor desk</a>${story.cluster_id ? h` · <a href="/clusters/${story.cluster_id}">Cluster</a>` : ''}${story.published_revision ? h` · <a href="${publicUrl}">Public page</a>` : ''}</p>
<h1>${story.working_headline}</h1>
${flash(message)}
<p class="meta">${story.id} · ${STATE_LABEL[story.state]}${story.published_revision ? ` · readers see revision ${story.published_revision}` : ''}${head ? ` · latest revision ${head.number}` : ''}</p>
${decision ? (decision.indexable ? h`<p class="meta">Search engines: indexable.</p>` : h`<p class="meta">Search engines: <strong>${decision.robots}</strong> — ${decision.reasons.map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}.</p>`) : ''}
${openFlags.length ? h`<section class="card warn"><h2>Open flags</h2><ul>${openFlags.map((f) => h`<li>${f.kind.replace('_', ' ')}${f.source_item_id ? ` · ${f.source_item_id}` : ''}${f.pending_revision ? h` · pending revision <a href="/edit/stories/${story.id}/preview?revision=${f.pending_revision}">${f.pending_revision}</a>` : ''}${f.note ? h` — ${f.note}` : ''}</li>`)}</ul></section>` : ''}
${head && problems.length ? h`<section class="card warn"><h2>Not publishable yet</h2><ul>${problems.map((p) => h`<li><code>${p.code}</code> ${p.detail}</li>`)}</ul></section>` : ''}
${head && head.meta.system ? h`<p class="notice">Revision ${head.number} was prepared by the system because a source ${head.meta.system.reason === 'source_removed' ? 'was removed' : 'changed'} upstream. Check the text, then save and publish.</p>` : ''}
${head && head.meta.gaps && head.meta.gaps.length ? h`<section class="card"><h2>What the AI draft could not support</h2><ul>${head.meta.gaps.map((g) => h`<li>${g}</li>`)}</ul></section>` : ''}

<section class="card"><h2>Text</h2>
<form method="post" action="/edit/stories/${story.id}/revise">${csrfField(csrf)}
${head ? h`<input type="hidden" name="expectedRevision" value="${head.number}">` : h`<input type="hidden" name="expectedRevision" value="0">`}
<label for="headline">Headline</label><input id="headline" name="headline" maxlength="200" required value="${head ? head.fields.headline : story.working_headline}">
<label for="body">Paragraphs <span class="meta">(blank line between paragraphs; end each with the numbers of the sources it rests on, e.g. <code>[1]</code> or <code>[1, 3]</code>)</span></label>
<textarea id="body" name="body" rows="18">${body}</textarea>
<label for="topic">Topic</label>${topicSelect(topics, topic ? topic.slug : '')}
<label><input type="checkbox" name="noindex" value="1"${raw(story.noindex ? ' checked' : '')}> Ask search engines not to index it</label><input type="hidden" name="noindex" value="0">
<label for="message">Revision note <span class="meta">(optional)</span></label><input id="message" name="message" maxlength="200">
<button type="submit">Save revision</button></form>
${aiEnabled ? h`<form method="post" action="/edit/stories/${story.id}/ai" class="inline">${csrfField(csrf)}<input type="hidden" name="workflow" value="news.summarize_story"><button type="submit">Ask OpenVibe.AI for a draft summary</button></form>
<form method="post" action="/edit/stories/${story.id}/ai" class="inline">${csrfField(csrf)}<input type="hidden" name="workflow" value="news.compare_perspectives"><button type="submit">Ask OpenVibe.AI to compare perspectives</button></form>
<p class="meta">AI output arrives as a draft revision marked AI-generated; it cannot be published until a person approves it below.</p>` : ''}
</section>

<section class="card"><h2>Sources</h2>
<table><thead><tr><th>#</th><th>Headline</th><th>Outlet</th><th>Status</th><th>Perspective</th><th></th></tr></thead><tbody>
${sources.map((s) => h`<tr${s.detached_at ? raw(' class="detached"') : ''}><td>${s.n}</td><td>${s.item.headline}<br><span class="meta">${s.item.id} · ${s.item.published_at ? s.item.published_at.slice(0, 10) : 'date not stated'}${s.item.summary ? ' · licensed summary kept' : ` · no summary (${s.item.summary_basis || 'none'})`}</span></td><td>${s.item.outlet}</td><td>${s.detached_at ? 'detached' : s.item.status}${s.item.removed_reason ? h`<br><span class="meta">${s.item.removed_reason}</span>` : ''}</td>
<td>${s.detached_at ? '' : h`<form method="post" action="/edit/stories/${story.id}/assign" class="inline">${csrfField(csrf)}<input type="hidden" name="item" value="${s.item.id}">${select('perspective', [['', '— none —'], ...perspectives.map((p) => [p.id, p.label])], s.perspective_id || '')}<button type="submit">Set</button></form>`}</td>
<td>${s.detached_at ? '' : h`<form method="post" action="/edit/stories/${story.id}/detach" class="inline">${csrfField(csrf)}<input type="hidden" name="item" value="${s.item.id}"><button type="submit">Detach</button></form>`}</td></tr>`)}
</tbody></table>
<form method="post" action="/edit/stories/${story.id}/attach">${csrfField(csrf)}<label for="item">Attach a source item (nsi_… or the Sources itm_… id)</label><input id="item" name="item" required><button type="submit">Attach</button></form>
</section>

<section class="card"><h2>Perspectives</h2><p class="meta">Labels are yours: describe the grouping (an outlet group, a stated position). Never invent a stance a source does not state.</p>
${perspectives.length ? h`<ul>${perspectives.map((p) => h`<li><strong>${p.label}</strong>${p.description ? h` — ${p.description}` : ''} <form method="post" action="/edit/stories/${story.id}/perspective/remove" class="inline">${csrfField(csrf)}<input type="hidden" name="perspective" value="${p.id}"><button type="submit">Remove</button></form></li>`)}</ul>` : ''}
<form method="post" action="/edit/stories/${story.id}/perspective">${csrfField(csrf)}<label for="label">Label</label><input id="label" name="label" maxlength="80" required><label for="description">Description</label><input id="description" name="description" maxlength="500"><button type="submit">Add perspective</button></form>
</section>

<section class="card"><h2>Timeline</h2>
${timeline.length ? h`<ul>${timeline.map((t) => h`<li>${t.occurred_on} — ${t.text} [${(live.find((s) => s.item.id === t.source_item_id) || {}).n || '?'}] <form method="post" action="/edit/stories/${story.id}/timeline/remove" class="inline">${csrfField(csrf)}<input type="hidden" name="entry" value="${t.id}"><button type="submit">Remove</button></form></li>`)}</ul>` : ''}
<form method="post" action="/edit/stories/${story.id}/timeline">${csrfField(csrf)}
<label for="occurredOn">Date the source states (YYYY-MM-DD)</label><input id="occurredOn" name="occurredOn" pattern="\\d{4}-\\d{2}-\\d{2}.*" required>
<label for="entry-text">What happened</label><input id="entry-text" name="text" maxlength="500" required>
<label for="entry-source">Source number</label>${select('source', live.map((s) => [String(s.n), `[${s.n}] ${s.item.outlet}`]), '')}
<button type="submit">Add to the timeline</button></form>
<p class="meta">Timeline, perspective and source changes reach readers with the next saved and published revision.</p>
</section>

<section class="card"><h2>Publish</h2>
${needsReview ? h`<form method="post" action="/edit/stories/${story.id}/review">${csrfField(csrf)}<input type="hidden" name="revision" value="${head.number}">
<p>Revision ${head.number} is ${rec.mode === 'ai' ? 'AI-generated' : 'AI-assisted'} (${rec.workflow ? rec.workflow.id : 'workflow'}). Read it against the sources before approving.</p>
${select('decision', [['approved', 'Approve: I checked every claim against its sources'], ['rejected', 'Reject']], 'approved')}<label for="review-note">Note</label><input id="review-note" name="note" maxlength="500"><button type="submit">Record review</button></form>` : ''}
${story.state !== 'retracted' && head ? h`<form method="post" action="/edit/stories/${story.id}/publish">${csrfField(csrf)}
<label for="pub-rev">Revision</label>${select('revision', revisions.map((r) => [String(r.number), `${r.number}${r.number === story.published_revision ? ' (published)' : ''} · ${r.createdAt.slice(0, 16).replace('T', ' ')}${r.meta.system ? ' · system' : ''}${r.meta.authorship && r.meta.authorship.mode !== 'human' ? ` · ${r.meta.authorship.mode}` : ''}`]), String(head.number))}
<label for="correction-kind">With a public note</label>${select('correctionKind', [['', '— none —'], ['correction', 'Correction'], ['update', 'Update']], '')}
<textarea id="correction-note" name="correctionNote" rows="2" maxlength="2000" aria-label="Correction or update note"></textarea>
<button type="submit">Publish</button> <a href="/edit/stories/${story.id}/preview?revision=${head.number}">Preview</a></form>` : ''}
${story.state === 'published' ? h`<form method="post" action="/edit/stories/${story.id}/retract">${csrfField(csrf)}<label for="retract-note">Retraction notice (public)</label><textarea id="retract-note" name="note" rows="2" maxlength="2000" required></textarea><button type="submit">Retract</button></form>` : ''}
${story.state === 'published' || story.state === 'retracted' ? h`<form method="post" action="/edit/stories/${story.id}/unpublish">${csrfField(csrf)}<button type="submit">Unpublish (take the page down)</button></form>` : ''}
</section>

<section class="card"><h2>Flags and history</h2>
<form method="post" action="/edit/stories/${story.id}/flag">${csrfField(csrf)}<label for="flag-kind">Add a note for the next publication</label>${select('kind', [['correction', 'Correction'], ['update', 'Update']], 'correction')}<textarea name="note" rows="2" maxlength="2000" required aria-label="Note"></textarea><button type="submit">Add</button></form>
${flags.length ? h`<ul>${flags.map((f) => h`<li>${f.kind.replace('_', ' ')} · ${f.status}${f.revision ? ` · revision ${f.revision}` : ''} · ${time(f.created_at)}${f.note ? h` — ${f.note}` : ''}</li>`)}</ul>` : ''}
<h3>Revisions</h3><ol reversed>${revisions.map((r) => h`<li>${r.number} · ${r.createdAt.slice(0, 16).replace('T', ' ')} · ${r.author || ''}${r.message ? h` — ${r.message}` : ''} · <a href="/edit/stories/${story.id}/preview?revision=${r.number}">preview</a>${r.number > 1 ? h` · <a href="/edit/stories/${story.id}/diff?from=${r.number - 1}&amp;to=${r.number}">diff</a>` : ''}</li>`)}</ol>
</section>`);
}

function diffPage({ story, diff }) {
    return String(h`<p><a href="/edit/stories/${story.id}">← Back to the story</a></p><h1>Revision ${diff.from} → ${diff.to}</h1>
${diff.fields.length ? h`<p class="meta">Changed fields: ${diff.fields.map((f) => f.field).join(', ')}</p>` : ''}
<div class="diff">${raw(ssr.diffHtml(diff.content))}</div>`);
}

function topicsPage({ topics, csrf, message }) {
    return String(h`<p><a href="/edit">← Editor desk</a></p><h1>Topics</h1>${flash(message)}
<ul>${topics.map((t) => h`<li>${t.name} <span class="meta">/topics/${t.slug}</span></li>`)}</ul>
<form method="post" action="/edit/topics">${csrfField(csrf)}<label for="name">Name</label><input id="name" name="name" maxlength="80" required><label for="description">Description</label><input id="description" name="description" maxlength="300"><button type="submit">Add topic</button></form>`);
}

module.exports = { dashboard, clusterPage, storyEditor, diffPage, topicsPage, flash };
