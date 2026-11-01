'use strict';

/**
 * AI briefs and the live view (server/domain/briefs.js; routes in http/public.js). Everything here that OpenVibe.AI
 * wrote is labelled as AI, and every paragraph links the reports it rests on, numbered in the table below it. The
 * reports' own headlines and links are the outlets'.
 */
const ssr = require('openvibe-publishing/ssr');
const { time, httpHref } = require('./pages');

const { html: h, raw } = ssr;
const TONES = [['brief', 'In brief'], ['neutral', 'Summary'], ['explained', 'Explained']];

const AI_NOTE = 'Written by OpenVibe.AI from the reports listed below, not by an editor. Each paragraph links the reports it rests on; read them before relying on it.';

function sourceTable(reports) {
    return h`<table class="sources brief-sources"><thead><tr><th>#</th><th>Report</th><th>Outlet</th><th>Date</th></tr></thead><tbody>
${reports.map((r, i) => h`<tr id="source-${i + 1}"><td>${i + 1}</td><td>${httpHref(r.canonical_url) ? h`<a href="${httpHref(r.canonical_url)}" rel="noopener nofollow" target="_blank">${r.headline}</a>` : r.headline}${r.summary ? h`<p class="source-summary">${r.summary}</p>` : ''}</td><td>${r.outlet}</td><td>${time(r.published_at ? Date.parse(r.published_at) : null)}</td></tr>`)}
</tbody></table>`;
}

/** Paragraphs whose sources are news item ids, cited by their place in `reports` (1-based). */
function paragraphs(brief, reports) {
    const n = new Map(reports.map((r, i) => [r.id, i + 1]));
    return brief.paragraphs.map((p) => {
        const nums = p.sources.map((id) => n.get(id)).filter(Boolean);
        return h`<p class="brief-p">${p.text}${nums.length ? h` <sup class="cites">${nums.map((x, i) => h`${i ? ',' : ''}<a href="#source-${x}" aria-label="report ${x}">${x}</a>`)}</sup>` : ''}</p>`;
    });
}

function makeButton(clusterId, { kind, tone, label }) {
    return h`<form class="brief-make" method="post" action="/briefs/${clusterId}/make"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="tone" value="${tone}"><button type="submit">${label}</button></form>`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "3 reports by 2 outlets: Reuters, AP" — how many covered it, and who (market outcome 2). */
const coverage = (reports, outlets) => `${plural(reports.length, 'report')} by ${plural(outlets.length, 'outlet')}${outlets.length ? `: ${outlets.slice(0, 6).join(', ')}${outlets.length > 6 ? ` and ${outlets.length - 6} more` : ''}` : ''}`;

/**
 * A story fewer outlets than the threshold have covered: the reports, and why there is no summary (market outcome 4).
 * One outlet's three reports are one outlet's account; a summary of it would read as more than it is.
 */
function reportsOnlyPage({ cluster, reports, outlets, minOutlets }) {
    return String(h`<header class="site-header"><p class="eyebrow"><span class="badge badge-reports">Reports</span> ${coverage(reports, outlets)}</p>
<h1>${cluster.label}</h1>
<p class="meta brief-held">No AI summary: ${outlets.length === 1 ? 'only one outlet has' : `only ${outlets.length} outlets have`} reported this, and we write one only once ${minOutlets} independent outlets have. Until then, here is what was reported, as each outlet put it.</p></header>
<section aria-labelledby="reports-h"><h2 id="reports-h">The reports</h2>${sourceTable(reports)}</section>
<p class="meta"><a href="/briefs">All AI briefs</a> · <a href="/live">Live</a> · <a href="/wire">The wire</a></p>`);
}

/** /briefs/:id */
function briefPage({ cluster, reports, brief, fresh, tone, perspectives, canMake, notice = null, enough = true, minOutlets = 2 }) {
    const outlets = [...new Set(reports.map((r) => r.outlet))];
    if (!enough) return reportsOnlyPage({ cluster, reports, outlets, minOutlets });
    const shown = brief && !brief.stub ? brief : null;
    const tabs = h`<nav class="brief-tones" aria-label="How to tell it">${TONES.map(([t, label]) => (t === tone
        ? h`<span class="brief-tone on" aria-current="page">${label}</span>`
        : h`<a class="brief-tone" href="/briefs/${cluster.id}${t === 'neutral' ? '' : `?tone=${t}`}">${label}</a>`))}</nav>`;
    const persp = perspectives && !perspectives.stub ? perspectives : null;
    return String(h`<header class="site-header"><p class="eyebrow"><span class="badge badge-ai">AI brief</span> from ${coverage(reports, outlets)}</p>
<h1>${shown && shown.headline ? shown.headline : cluster.label}</h1>
<p class="meta">${AI_NOTE}</p></header>
${notice ? h`<p class="notice">${notice}</p>` : ''}
${tabs}
<section class="brief" aria-label="The brief">
${shown ? h`${paragraphs(shown, reports)}${!fresh ? h`<p class="notice small">New reports arrived since this was written. ${canMake ? makeButton(cluster.id, { kind: 'summary', tone, label: 'Write it again' }) : ''}</p>` : ''}`
        : h`<p class="empty">${canMake ? h`Not written in this tone yet. ${makeButton(cluster.id, { kind: 'summary', tone, label: 'Write it with AI' })}` : 'No brief yet.'}</p>`}
</section>
${outlets.length >= 2 ? h`<section class="brief-frames" aria-labelledby="frames-h"><h2 id="frames-h">How the outlets put it</h2>
${persp ? h`<p class="meta">${AI_NOTE}</p>${paragraphs(persp, reports)}` : h`<p class="meta">How each outlet frames this, side by side, with what they agree and differ on.</p>${canMake ? makeButton(cluster.id, { kind: 'perspectives', tone: 'neutral', label: 'Compare the outlets with AI' }) : ''}`}
</section>` : ''}
<section aria-labelledby="reports-h"><h2 id="reports-h">The reports</h2>${sourceTable(reports)}</section>
${shown && shown.gaps.length ? h`<details class="brief-gaps"><summary>What the AI left out (${shown.gaps.length})</summary><ul>${shown.gaps.map((g) => h`<li>${g}</li>`)}</ul></details>` : ''}
<p class="meta"><a href="/briefs">All AI briefs</a> · <a href="/live">Live</a> · <a href="/wire">The wire</a></p>`);
}

/** /briefs */
function briefsIndex({ briefs }) {
    return String(h`<header class="site-header"><h1>AI briefs</h1><p class="lede">What the reports on a subject say, summarized by OpenVibe.AI with every paragraph linked to its reports, and labelled as AI. Editors' stories are on <a href="/">the front page</a>.</p></header>
${briefs.length ? h`<ol class="story-list">${briefs.map((b) => h`<li class="story-item"><h2 class="story-item-title"><a href="/briefs/${b.cluster_id}">${b.headline || b.label}</a> <span class="badge badge-ai">AI</span></h2>
<p class="meta">${time(b.window_end)} · from ${b.item_count} reports${b.outlets ? ` by ${b.outlets} outlets` : ''}</p>${b.paragraphs[0] ? h`<p class="summary">${b.paragraphs[0].text.slice(0, 280)}${b.paragraphs[0].text.length > 280 ? '…' : ''}</p>` : ''}</li>`)}</ol>`
        : h`<p class="empty">No briefs yet. One is written once two or more independent outlets have reported a subject.</p>`}`);
}

/** /live: the newest reports as they arrive, grouped, with what is breaking. */
function livePage({ clusters, briefIds, breaking }) {
    return String(h`<header class="site-header"><h1>Live <span class="live-dot" aria-hidden="true"></span></h1><p class="lede">The newest reports from the sources OpenVibe.News follows, as they arrive. This page refreshes itself every minute. <span class="badge badge-breaking">Breaking</span> marks a subject three or more reports covered in the last two hours.</p></header>
${clusters.length ? h`<ol class="wire-list wide live-list">${clusters.map((c) => h`<li class="wire-cluster${breaking.has(c.id) ? ' is-breaking' : ''}">
<p class="wire-lead">${breaking.has(c.id) ? h`<span class="badge badge-breaking">Breaking</span> ` : ''}<strong>${c.label}</strong>${briefIds.has(c.id) ? h` · <a href="/briefs/${c.id}">AI brief</a>` : ''}</p>
<ul class="wire-items">${c.items.slice(0, 5).map((i) => h`<li>${httpHref(i.url) ? h`<a href="${httpHref(i.url)}" rel="nofollow noopener" target="_blank">${i.headline}</a>` : i.headline} <span class="meta">${i.outlet} · ${time(i.published_at ? Date.parse(i.published_at) : null)}</span></li>`)}</ul></li>`)}</ol>`
        : h`<p class="empty">Nothing new from the sources yet.</p>`}`);
}

module.exports = { briefPage, briefsIndex, livePage, AI_NOTE, TONES };
