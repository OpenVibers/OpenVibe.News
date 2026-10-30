'use strict';
/**
 * The front page (/ page 1): what OpenVibe.News is for, then real content only. The numbers, editors' stories, the
 * latest AI briefs (labelled), the wire, every topic with what was reported on it, the outlets News reads, how it
 * works, questions and the ways around the site. A section with nothing to show is left out.
 */
const ssr = require('openvibe-publishing/ssr');
const showcase = require('openvibe-shared/showcase');
const { time, httpHref, storyList } = require('./pages');

const { html: h, raw } = ssr;
const { pickList, pickListRule, foldBlock } = require('./short');
const num = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);

/** The questions the front page answers (shown, and given as FAQPage); the outlets one names today's outlets. */
function faq(outlets) {
    const names = outlets.map((o) => o.outlet);
    return [
        { q: 'Who writes OpenVibe.News?', a: 'Two kinds of text, each labelled. AI briefs are written by OpenVibe.AI from the reports on one subject, with every paragraph linked to the reports it rests on. Stories are written by editors, and every paragraph cites its sources. The wire and the Live page show the outlets\' own headlines, linked to their reports.' },
        { q: 'Where do the reports come from?', a: `From public feeds that OpenVibe.Sources collects after checking each publisher's terms and robots.txt.${names.length ? ` In the last 30 days: ${list(names)}.` : ''} News keeps headlines, links and short summaries only, and links every report back to its publisher.` },
        { q: 'Can I change how a brief is told?', a: 'Yes. A brief comes in brief, summary or explained form. When two or more outlets reported on a subject, AI can also compare how each one puts it.' },
        { q: 'What does Breaking mean?', a: 'On the Live page, Breaking marks a subject that three or more reports covered in the last two hours. The page refreshes itself every minute.' },
        { q: 'Why are AI briefs not in search results?', a: 'No editor has reviewed them, so they are kept out of search engines until a person does. Editors\' stories and topic pages are indexed.' },
        { q: 'What happens when a story is wrong?', a: 'Corrections and retractions stay on the record. A story shows its correction history, and a retracted story stays up, labelled, with the reason.' },
    ];
}

function statsPanel(stats) {
    const tiles = [
        stats.stories ? ['Stories published', stats.stories] : null,
        ['Reports in the last day', stats.day],
        ['Reports this week', stats.week],
        stats.outlets ? ['Outlets read this month', stats.outlets] : null,
        stats.briefs ? ['AI briefs', stats.briefs] : null,
        stats.stories && stats.topics ? ['Topics', stats.topics] : null,   // with the stories tile, six in two columns
    ].filter(Boolean);
    if (!stats.week && !stats.stories) return '';
    return String(h`<div class="nh-panel"><h2 class="nh-panel-h">The newsroom today</h2><dl class="nh-stats">${tiles.map(([k, v]) => h`<div><dt>${k}</dt><dd>${num(v)}</dd></div>`)}</dl>
<p class="nh-live"><span class="live-dot" aria-hidden="true"></span> <a href="/live">Watch reports arrive live</a></p></div>`);
}

function briefCard(b, i) {
    const first = b.paragraphs[0] ? b.paragraphs[0].text : '';
    return h`<li class="nh-card" data-i="${i}"><p class="nh-kicker"><span class="badge badge-ai">AI brief</span> from ${plural(b.item_count, 'report')}</p>
<h3><a href="/briefs/${b.cluster_id}">${b.headline || b.label}</a></h3><p class="meta">${time(b.window_end)}</p>${first ? h`<p class="nh-sum">${clip(first, 260)}</p>` : ''}</li>`;
}

/**
 * o: items (editors' stories, page 1), pager, feeds, stats, briefs, wire (pages.wireSection HTML), topics (active),
 * tally (Map slug → { subjects, reports, newest }), outlets
 */
function homeBody(o) {
    const { items, pager, feeds, stats, briefs = [], wire = '', wireClusters = [], topics = [], tally = new Map(), outlets = [] } = o;
    const questions = faq(outlets);
    return String(h`${raw(showcase.hero({
        eyebrow: 'OpenVibe.News',
        title: 'News you can', accent: 'check',
        lede: 'Every paragraph links the reports it rests on. Read AI briefs that cite every claim, watch reports arrive live, and check any of it yourself. No account needed.',
        // Two, so they sit side by side on a phone; the topics are a section of their own below.
        actions: [{ label: 'Read the latest', href: '#latest', primary: true }, { label: 'Live', href: '/live' }],
        aside: stats ? { html: statsPanel(stats) } : undefined,
    }))}
<div id="latest"></div>
${items.length ? raw(pickList({
        key: 'stories',
        label: 'Latest stories',
        head: 'Latest stories',
        labels: items.map((it) => clip(it.headline || 'A story', 42)),
        html: h`<section class="sc-sec nh-sec" id="stories" aria-labelledby="nh-stories-h"><h2 id="nh-stories-h">Latest stories</h2>
${feeds.length ? h`<p class="feeds">Follow: ${feeds.map((f) => h`<a href="${f.href}">${f.label}</a> `)}</p>` : ''}
${storyList(items, '', { pick: true })}${raw(ssr.paginationHtml(pager))}</section>`,
    })) : ''}
${briefs.length ? raw(pickList({
        key: 'briefs',
        label: items.length ? 'AI briefs' : 'Latest AI briefs',
        head: items.length ? 'AI briefs' : 'Latest AI briefs',
        labels: briefs.map((b) => clip(b.label || b.headline || 'A brief', 42)),
        html: h`<section class="sc-sec nh-sec" aria-labelledby="nh-briefs-h"><h2 id="nh-briefs-h">${items.length ? 'AI briefs' : 'Latest AI briefs'}</h2>
<p class="sc-lede">What the reports on each subject say, written by OpenVibe.AI with every paragraph linked to its reports. Not written or reviewed by an editor.</p>
<ol class="nh-cards pick-list">${briefs.map((b, i) => briefCard(b, i))}</ol><p class="nh-more"><a href="/briefs">All AI briefs</a></p></section>`,
    })) : ''}
${wire ? raw(pickList({
        key: 'wire',
        label: 'From the wire',
        head: 'From the wire',
        labels: (wireClusters || []).map((c) => clip(c.label || 'A report', 42)),
        html: h`<div class="sc-sec nh-sec nh-wire">${raw(wire)}<p class="nh-more"><a href="/live">Live: the newest reports, refreshed every minute</a></p></div>`,
    })) : ''}
${topics.length ? raw(pickList({
        key: 'topics',
        label: 'Topics',
        head: 'Topics',
        labels: topics.map((t) => t.name),
        html: h`<section class="sc-sec nh-sec" id="topics" aria-labelledby="nh-topics-h"><h2 id="nh-topics-h">Topics</h2><p class="sc-lede">What the sources reported on each topic in the last 30 days.</p>
<ul class="nh-topics pick-list">${topics.map((t, i) => {
        const x = tally.get(t.slug);
        const item = x && x.newest && x.newest.item;
        const href = item ? httpHref(item.url) : null;
        return h`<li data-i="${i}"><h3><a href="/topics/${t.slug}">${t.name}</a></h3>${x ? h`<p class="nh-count">${plural(x.subjects, 'subject')}, ${plural(x.reports, 'report')}</p>` : ''}
${item ? h`<p class="nh-latest">${href ? h`<a href="${href}" rel="nofollow noopener" target="_blank">${item.headline}</a>` : item.headline} <span class="meta">${item.outlet}</span></p>` : (t.description ? h`<p class="nh-latest meta">${t.description}</p>` : '')}</li>`;
    })}</ul><p class="nh-more"><a href="/topics">All ${plural(topics.length, 'topic')}</a></p></section>`,
    })) : ''}
${outlets.length ? raw(foldBlock({
        id: 'outlets',
        head: '<h2 id="nh-outlets-h">The sources we read</h2>',
        html: h`<section class="sc-sec nh-sec" aria-labelledby="nh-outlets-h"><h2>The sources we read</h2>
<p class="sc-lede">Public feeds, collected by OpenVibe.Sources with each publisher's terms and robots.txt checked. Headlines, links and short summaries only.</p>
<ul class="nh-outlets">${outlets.map((x) => h`<li><b>${x.outlet}</b><span class="nh-count">${plural(x.week, 'report')} this week · ${num(x.month)} in 30 days</span>${x.latest ? h`<span class="nh-latest">Newest: ${httpHref(x.latest.url) ? h`<a href="${httpHref(x.latest.url)}" rel="nofollow noopener" target="_blank">${x.latest.headline}</a>` : x.latest.headline}</span>` : ''}</li>`)}</ul></section>`,
    })) : ''}
<div class="sc-sec nh-sec"><details class="nh-fold"><summary>How a story is built<span>citations, revisions, briefs</span></summary>${raw(showcase.features({
        items: [
            { icon: 'ov:news', title: 'Cited paragraphs', text: 'Each paragraph names the sources behind it, with outlet, authors and date.' },
            { icon: 'ov:history', title: 'Revisions on the record', text: 'Corrections and retractions are kept and shown, never quietly edited away.' },
            { icon: 'ov:search', title: 'Source checks', text: 'When a source changes or is removed upstream, the story says so while editors check it.' },
            { icon: 'ov:community', title: 'Discussion', text: 'Talk about a story on OpenVibe.Community with your OpenVibe account.' },
        ],
    }))}
${raw(showcase.steps({
        title: 'From report to brief',
        items: [
            { title: 'Public feeds come in', text: 'OpenVibe.Sources reads each publisher\'s own feed, within its terms, and hands News the headline, link and short summary.' },
            { title: 'Reports are grouped by subject', text: 'Reports that share names and words become one subject. Every grouping can be explained, and editors can split it.' },
            { title: 'AI writes a cited brief', text: 'Once enough reports cover a subject, OpenVibe.AI summarises them. Every paragraph links the reports it used.', href: '/briefs' },
            { title: 'Editors write the stories', text: 'Stories cite every paragraph. Corrections and retractions stay on the record.' },
        ],
    }))}</details></div>
${raw(foldBlock({
        id: 'faq',
        head: '<h2 id="nh-faq-h">Questions</h2>',
        html: h`<section class="sc-sec nh-sec nh-faq" aria-labelledby="nh-faq-h"><h2>Questions</h2>${questions.map((f) => h`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</section>`,
    }))}`);
}

/** Structured data for the front page: the site, its topic pages as an ItemList (indexed pages), the questions shown. */
function homeJsonLd({ abs, topics, outlets }) {
    const out = [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'OpenVibe.News', url: abs('/') }];
    if (topics.length) out.push({ '@context': 'https://schema.org', '@type': 'ItemList', name: 'Topics on OpenVibe.News', numberOfItems: topics.length, itemListElement: topics.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, url: abs(`/topics/${t.slug}`) })) });
    out.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq(outlets).map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
    return out;
}

module.exports = { homeBody, homeJsonLd, faq };
