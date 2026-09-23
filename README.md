# OpenVibe.News

> Source-backed stories: clustered coverage, cited paragraphs, perspectives, timelines and a
> public correction history.

**Status:** alpha (roadmap Wave 17, News half). The service runs and its tests pass. It is
**deployed internally, not launched**: it runs on the production host on 127.0.0.1:4820 only
(release `1802e7d`, `/api/ready` 200), while `openvibe.news` still shows its placeholder from
OpenVibe.Sites. Its capabilities and service manifest are registered in openvibe-contracts v0.21.0.
The production database holds 12 topics and no stories: it has not ingested anything from the
running OpenVibe.Sources service, because every Sources seed is disabled.
**Domain:** `openvibe.news` · **Port:** 4820 · **Service id:** `news`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.7; roadmap §15.13, §29, §32.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

A publication product, not an autonomous headline generator. OpenVibe.Sources collects news items
(headline, link, outlet, dates, terms). News normalises them, removes duplicates, groups them into
explainable clusters, and gives editors the tools to write stories from them. Every paragraph an
editor publishes cites the source items it rests on. A story with no sources cannot be published.
When a source changes or is withdrawn upstream, the story is flagged and a pending revision is
prepared; published text never changes silently. Full article text from sources is never stored,
shown, fed or indexed.

News publishes nothing until an editor does: the only seed is the topic list.

## Owns

The nine charter tables live in News' own SQLite (`NEWS_DB_PATH`):

| Charter table | What it is |
|---|---|
| `news_topics` | Owned by News. Canonical topic identities (slug, name, description). The only seed (`seeds/topics.json`). |
| `news_source_items` | Owned by News. One row per Sources item (`sources_item_id` is a typed reference to `itm_…`): headline, canonical URL, outlet, authors, `published_at` as the source states it, the licence and terms notes, and a short summary **only** when those notes allow short summaries. Dedupe outcome (`status`, `duplicate_of`, `dedupe`), cluster and the stored reason for it, upstream revision and removal. No article body. |
| `news_story_clusters` | Owned by News. Clusters with their key terms and entities, time window, status (`open`, `merged`, `dissolved`) and lineage (`merged_into`, `split_from`). |
| `news_stories` | Owned by News. Publication state: slug, state (`draft`, `published`, `unpublished`, `retracted`), published revision, topic, cluster. |
| `news_story_revisions` | `openvibe-publishing/revisions` (prefix `news_story`). Immutable. Each revision holds the headline, the paragraphs with their source numbers, and a snapshot of the source table, timeline and perspectives. |
| `news_story_sources` | Owned by News. The story's source table: which items, their stable numbers `[n]` (never reused), perspective grouping, detachment. |
| `news_perspectives` | Owned by News. Editor-written labels that group a story's sources (for example an outlet group or a position a source states). Never generated. |
| `news_timeline_entries` | Owned by News. Dated entries; each date is one the source states and each entry rests on one attached source. |
| `news_editorial_flags` | Owned by News. `correction`, `update`, `retraction` (public, with notes) and `source_updated`, `source_removed` (upstream changes, with the pending revision). |

Other tables in the same database:

- Package companions: `news_story_citations` (one row per paragraph and timeline entry and cited
  Sources item, append-only), `news_story_reviews` (a person's approval of AI output),
  `news_story_drafts`, `news_story_revision_purges`, `news_index_revisions` (Search sequencer),
  `news_story_discussion_refs` (a story's OpenVibe.Community thread id; never a comment, a count or
  an author).
- `news_cluster_audit`: every merge, split and reversal with exactly which items moved.
- `news_ingest_runs`: what every webhook delivery, pull and upstream fetch failure did.
- `news_state` (the Sources cursor), `news_source_status` (display cache of Sources' registry
  names and health), `event_outbox` and `idempotency_receipts` (openvibe-sdk),
  `subject_projections` (Network names). None of them is authority for anything outside News.

## Does not own

- **Source adapters and the source registry.** OpenVibe.Sources owns them: which sites are read,
  under which terms, how and when. News reads items with `sources.item.read` and never fetches a
  site itself.
- **Discussion.** OpenVibe.Community owns the comment threads, their comments and their
  moderation. News keeps only each story's thread id and reads the thread on every render.
- **AI generation.** OpenVibe.AI. News only receives drafts.
- **Search.** OpenVibe.Search indexes what News sends through Events.
- **Identity.** OpenVibe.Network: SSO, subjects and service principals.

## What works

- **Ingestion** from OpenVibe.Sources, two ways with one effect:
  - an Events webhook (`POST /internal/events`, signed with `NEWS_EVENTS_SECRET`) for
    `sources.item.created|updated|removed` and `sources.fetch.failed`, each applied exactly once
    through the SDK inbox;
  - a cursor pull (`GET /api/v1/items?category=news&after=…&include_removed=1`) every
    `NEWS_PULL_INTERVAL_MS`, the backstop for missed deliveries.
  Applying an item is idempotent on (Sources item id, revision). Failures are recorded states
  (`news_ingest_runs`, `news.source.failed`, `/api/ready`, the editor desk) and never create a
  source item, a cluster or any story text. When Sources cannot be read, the delivery is answered
  503 so Events retries it.
- **Licensing.** Only headline, URL, outlet, authors, `published_at`, the notes and — when the
  item's terms or licence note explicitly allows short summaries and nothing forbids them — a
  summary of at most `NEWS_SUMMARY_MAX_CHARS` (280) are kept. Anything else a Sources item carries
  (for example an article body an adapter mapped into `fields`) is never read. A removed item's
  summary is dropped. Source summaries appear only in a story's source table; never in feeds,
  Search documents or events.
- **Dedupe** (explainable, stored on the item): the same normalised canonical URL (tracking
  parameters, `www.`, trailing slashes ignored), the same Sources content hash, or a near-duplicate
  headline (Jaccard of word 2-shingles ≥ 0.9, or ≥ 0.75 from the same outlet, within 48 h).
  Duplicates are kept for provenance, join their original's cluster and are not attached to new
  stories by default.
- **Clusters** (deterministic): an item joins the open cluster, within `NEWS_CLUSTER_WINDOW_HOURS`
  (72), with which it shares at least one named entity and two terms, or at least three terms;
  entities score 2, terms 1; ties go to the oldest cluster. The shared entities, shared terms and
  score are stored on the item and shown on the cluster page. Editors can merge clusters and split
  items off; both are audited and reversible (`news_cluster_audit`).
- **Stories** (editorial):
  - An editor opens a story from a cluster; its live, non-duplicate items become sources
    `[1]`, `[2]`, … . Editors can attach and detach sources; numbers are never reused.
  - Paragraphs end with the source numbers they rest on (`… [1, 3]`). A revision with an uncited
    paragraph, or citing a number not in the source table, is refused.
  - Revisions are immutable with optimistic concurrency (412 on a stale base), diff and preview.
  - Publishing is refused while the revision has no sources (`story.unsourced`), cites a source
    removed upstream or detached, or is AI-generated or AI-assisted without a person's approval.
  - Timeline entries have a date the source states and one source each. Perspectives are labels
    an editor writes; readers can re-frame the source table by number, outlet or perspective
    (`?group=`), without JavaScript.
  - Corrections and updates are notes published with a revision and shown in the story's
    correction history. Retraction keeps the story at its URL with a retraction notice, noindex,
    out of sitemaps and Search, labelled in listings and feeds; it is final.
- **Upstream changes.** When a cited source is revised or removed in Sources, every story citing it
  gets an open flag and a pending revision prepared by the system (same text, refreshed source
  entry). The published revision stays exactly as it was, with a notice to readers. A removed
  source's headline, summary and link leave the public page at once; a paragraph resting only on
  it is marked, and the gate makes the story noindex (`unsupported_claims`) until an editor
  publishes a revision that no longer rests on it — with a correction or update note.
- **Comments** (OpenVibe.Community, referenced, never copied):
  - A story open for discussion gets the thread Community resolves for EntityRef
    `{ service: 'news', type: 'story', id }`, the first time its page is read. Open means published
    (indexable or not: a noindex story is still public) with no paragraph resting only on a source
    removed upstream. Drafts never get a thread: a Community thread is readable by anyone with its id.
  - Only the thread id is stored (`news_story_discussion_refs`). The page reads the thread from
    Community on every render, so Community's moderation and deletions are what readers see. When
    Community cannot be read the page says comments are unavailable; it never shows an empty or
    invented thread.
  - Signed-in members comment with a plain form (`POST /stories/:slug/comments`, form token), as
    themselves (`X-OV-Subject`, `community.comment.write`).
  - Retracting or unpublishing a story, or a removal upstream that leaves a paragraph without a
    source, hides its thread; publishing a revision that no longer rests on the removed source (or
    republishing) shows it again. The call (`community.comment.moderate`) runs after the change
    commits, is best effort, and never fails the change. A retracted story's page says comments are
    closed; a story waiting for a revision says they are paused.
- **AI** (optional seams, never publication truth):
  - OpenVibe.AI may deliver a draft revision with `X-OV-Origin: ai` (`news.story.revise`), naming
    `news.summarize_story` or `news.compare_perspectives` and its run.
  - An editor may ask for one (`POST /api/v1/stories/:id/ai-drafts`, or the desk's button when
    `OV_AI_INTERNAL_URL` is set). Only News' stored fields are sent. Claims the model did not cite
    are dropped and listed as gaps. A failed run makes no text. AI never creates perspective labels.
  - AI-generated revisions, and AI-assisted ones (an editor's edit of AI text), cannot be published
    and are hidden from indexes until a person (`usr_`) records an approving review of that
    revision. Stub-provider output is held too. The disclosure is on the page, in the JSON and in
    the Search document.
  - With no AI configured, editors write every story from the source items.

### Routes (server-rendered, useful without JavaScript)

| Route | What |
|---|---|
| `/` | published stories, newest first (retracted ones stay, labelled) and the topics |
| `/topics`, `/topics/:slug` | topics and each topic's stories |
| `/stories/:slug`, `/stories/:slug.json` | a story (text with source numbers, source table, timeline, perspectives, corrections, the Community comment thread), and the same story as data |
| `POST /stories/:slug/comments` | comment on the story's Community thread as the signed-in member (form token) |
| `/feed.xml`, `/atom.xml`, `/feed.json`, `/topics/:slug/{feed.xml,atom.xml,feed.json}` | feeds (News' own text only) |
| `/sitemap.xml` → `/sitemaps/stories.xml`, `/sitemaps/topics.xml` | indexable stories and topics only |
| `/robots.txt`, `/llms.txt` | the automated-consumer policy and machine orientation |
| `/edit`, `/edit/stories/:id`, `/clusters/:id` | the editor desk (forms, Network SSO, form tokens; editors only; private, noindex) |
| `/auth/*` | sign-in; the same session layer as OpenVibe.Community and OpenVibe.Blog |
| `/internal/events` | the Events webhook (loopback; nginx does not proxy it) |
| `/api/health`, `/api/ready`, `/release.json`, `/metrics` | health, truthful readiness, release, metrics (`/metrics` loopback only) |

### Discoverability (roadmap §32)

- Robots meta, canonical and `X-Robots-Tag` come from the `openvibe-publishing/seo` gate with
  explicit reasons. News' policy: at least two independent live cited sources
  (`NEWS_MIN_INDEPENDENT_SOURCES`, default 2), at least 40 words; unsupported claims, retraction,
  an editor's noindex and unreviewed AI output are never indexable.
- **Independent sources** (`text.independentSources`): the live Sources items the published
  revision's paragraphs cite, where items count as one source when they share the OpenVibe.Sources
  source (`source_key`: the same feed or registry entry), the publisher's domain of their canonical
  URL (`news.example.com` and `www.example.com` are `example.com`; `news.bbc.co.uk` is
  `bbc.co.uk`), the outlet name, or the original report they duplicate (a syndicated or copied
  report dedupe marked as a duplicate). The relation is transitive and deliberately coarse: two
  sites on one shared host count once. A story on fewer independent sources is still published,
  listed and readable, but `noindex` with the reason `unsourced` (for example `1 of 2 sources`),
  so it is out of the sitemaps and its Search document says noindex. Setting the minimum to 1
  restores the one-source gate.
- JSON-LD `NewsArticle` from real fields only: headline, dates, the editors named in the
  revision's authorship (only when the Network name is known), the section (topic), the cited
  source URLs, and OpenVibe.News as publisher. Missing fields are omitted.
- Drafts, unpublished, retracted and noindex stories never appear in sitemaps or Search; feeds
  list published and (labelled) retracted stories, never a draft.

### Caching

HTML and JSON vary on `Cookie` and `Authorization`. Published stories and lists rendered for an
anonymous visitor are `public, max-age=60`; everything else (signed-in views, the desk, previews,
refusals, the API) is `private, no-store` with `X-Robots-Tag`. Feeds and sitemaps are public for
five minutes and are never built for a viewer.

### Events (SDK outbox, same transaction as the change)

| Event | Notes |
|---|---|
| `news.source.ingested` | internal; per Sources item created, revised or removed, with the dedupe and cluster outcome |
| `news.source.failed` | internal; a Sources fetch failure of a news source, an unreadable item, or a failed pull (once per outage) |
| `news.cluster.updated` | internal; created, grew, merged, split, reversed |
| `news.story.created`, `news.story.flagged` | internal |
| `news.story.published`, `.updated`, `.unpublished` | `openvibe-publishing/index-hooks` `publicationEvent`; canonical URL, state, indexability, topic; never the text |
| `news.story.retracted` | public for a listable story; the retraction note |
| `news.index_document.upserted` / `.deleted` | `search.index-document@1` documents (provenance: the Sources items and the AI run) and tombstones, with a monotonic index revision |

### Capabilities (registered in openvibe-contracts v0.21.0)

Service tokens use audience `openvibe.news`, one capability per route; the editor the service acts
for goes in `X-OV-Subject` and must be an editor:

- `news.story.create`, `news.story.read`, `news.story.revise`, `news.story.publish`, `news.story.retract`
- `news.cluster.read`, `news.cluster.manage`
- `news.source.attach`, `news.timeline.update`, `news.perspective.update`
- `news.topic.manage`

Browser and app user JWTs are judged as editors (`NEWS_EDITORS` subjects and Network admins).
Grants for these ids are decided with the contracts library's matching rule
(`server/auth/capabilities.js`). The ids and the service manifest are released in
openvibe-contracts v0.21.0; `docs/capabilities-proposal/` and `docs/service-manifest-proposal.json`
are the proposals they were released from.

## Depends on

- **Packages** (pinned by release tarball): `openvibe-publishing` v0.2.1 (revisions, citations,
  authorship, seo, index-hooks, ssr, taxonomy slugify), `openvibe-contracts` v0.33.0,
  `openvibe-shared` v1.5.1 (chrome, app icon, footer, legal, release, metrics, ready, seo),
  `openvibe-sdk` v0.5.0 (events outbox and inbox, webhook signatures v2, service tokens).
- **OpenVibe.Sources** (4720): `sources.item.read`; optionally `sources.source.read` (outlet
  names and source health; without it the outlet is the URL's host).
- **OpenVibe.Events** (4300): `events.event.publish`; `events.subscription.manage` to create the
  `sources.item.*` and `sources.fetch.failed` subscriptions (`npm run subscribe`).
- **OpenVibe.Network** (4000): SSO (OAuth client `news`, redirect `https://openvibe.news/auth/callback`),
  JWKS, `identity.subject.resolve` for editor names.
- **OpenVibe.Community** (4200): `community.comment.write` (resolve a story's thread, comment as
  the signed-in member) and `community.comment.moderate` (hide and show a story's thread).
  Without them a story page says comments are unavailable; nothing else depends on Community.
- **OpenVibe.Search**: consumes `news.index_document.*` through its `*.index_document.*`
  subscription; `news` must be in `SEARCH_EVENT_OWNERS`.
- **Optional:** OpenVibe.AI (4700) with `ai.run.create` for namespace `news.*` (a bare `news` only matches a workflow literally named `news`).

### Grants the Network must hold

Each grant is `[client, capability, audience]`:

- `[news, sources.item.read, openvibe.sources]`
- `[news, sources.source.read, openvibe.sources]` (optional: outlet names and health)
- `[news, events.event.publish, openvibe.events]`
- `[news, events.subscription.manage, openvibe.events]`
- `[news, identity.subject.resolve, openvibe.network]`
- `[news, community.comment.write, openvibe.community]` (comment threads on stories)
- `[news, community.comment.moderate, openvibe.community]` (hide the thread of a retracted,
  unpublished or source-removed story)
- `[news, ai.run.create, openvibe.ai]`, namespace `news.*` (optional: only with `OV_AI_INTERNAL_URL`)
- For OpenVibe.AI to deliver drafts: `[ai, news.story.revise, openvibe.news]`, and
  `[ai, news.story.read, openvibe.news]` if it reads stories back.

## Acceptance (automated: `npm test`)

| Charter / roadmap requirement | Test |
|---|---|
| Every published claim traces to source records: each paragraph's numbers resolve to Sources items in the page, the JSON, the citations table and the Search document's provenance. | `test/stories.test.js` |
| A story with zero sources cannot be published; an uncited paragraph is refused. | `test/stories.test.js` |
| Failed ingestion never fabricates: failed pulls, unreadable deliveries, `sources.fetch.failed` and title-less items are recorded and create no item, cluster or story text. | `test/ingest.test.js` |
| A source correction or removal triggers a flag and a pending revision; published text is unchanged; a removed source leaves the page; publishing a revision that rests on it is refused; the editor's revision resolves the flags with a note. | `test/upstream.test.js` |
| Community discussion is referenced, not duplicated: one thread per published story, only its id stored, read on render; Community down says comments are unavailable; drafts get no thread; retraction, unpublishing and a removed source hide it after the commit; members comment by form as themselves. | `test/discussion.test.js` |
| Licensed material never leaks: bodies and summaries beyond the allowance never reach the database, pages, JSON, feeds, sitemaps, the API, events or Search. | `test/licensing.test.js` |
| Dedupe by canonical URL, content hash and near-duplicate headline; idempotent replays. | `test/ingest.test.js` |
| Clusters are deterministic and explained; merges and splits are audited and reversible. | `test/clusters.test.js` |
| The index gate counts independent sources: a single-source story, two items of one Sources source, two sources of one publisher's domain and a report with its syndicated copy are published but noindex and out of the sitemap; two independent sources are indexable; `NEWS_MIN_INDEPENDENT_SOURCES=1` restores the old gate. | `test/indexability.test.js` |
| Retraction: visible at its URL with the notice, noindex with its reason, out of sitemaps and Search, event emitted, final. | `test/retraction.test.js` |
| Useful without JavaScript: the whole editorial journey with forms, and public pages complete in HTML. | `test/nojs.test.js` |
| AI output is a draft that needs a person's review (AI-assisted too); uncited claims dropped; failure makes no text. | `test/ai.test.js` |
| The contract proposals are valid and match the code; every emitted event type is declared. | `test/contracts.test.js` |
| Health, readiness, release, robots, llms.txt, sitemaps, legal, problems, CORS, topics-only seed. | `test/ops.test.js` |

Not yet demonstrated: ingestion from the deployed OpenVibe.Sources (its seeds are disabled until a
person verifies their terms; production has 181 ingest runs and 0 items), delivery of a real item
through the running OpenVibe.Events (the `sources.item.*` and `sources.fetch.failed` subscriptions
exist), and an OpenVibe.AI run (OpenVibe.AI runs on the host, but News in production has no
`OV_AI_INTERNAL_URL`; the seam is tested against a mock of its runs API).

## Launch rule

This repository alone doesn't make the product live. `openvibe.news` keeps its placeholder on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of plan §12.12
exists:

1. **Runtime, health, readiness, observability:** done.
2. **Canonical identity and auth:** done (Network SSO, subjects, service tokens).
3. **SSR public routes useful without JS:** done.
4. **Persistence and end-to-end workflows:** done in tests and deployed on the host (loopback
   only); not yet against live Sources items, since no news source is enabled.
5. **Capability and event registration against OpenVibe.Contracts:** done (openvibe-contracts
   v0.21.0).
6. **Migration and seed strategy, threat review, sitemap/robots/feed behaviour:** done. Nothing
   to migrate; the seed is topics only; the threat review is below.
7. **Acceptance tests:** done.

The launch release removes `openvibe.news` from `OpenVibe.Sites/sites.json`, switches routing
(nginx vhost, DNS, TLS), flips the Network hub entry and registers maturity in the ecosystem
registry, together. A placeholder never counts as an implemented service, and this README doesn't
call the service live.

## Security and threat review

- **Identity:** only verified Network JWTs (offline RS256) and service tokens for audience
  `openvibe.news`. A bad service token is refused, never downgraded. Identity never comes from a
  body or query; `X-OV-*` headers are ignored for browsers. AI deliveries can only write drafts.
- **Webhook:** signature v2 only: HMAC-SHA256 over `<timestamp>.<raw body>` with
  `NEWS_EVENTS_SECRET` (rotation: comma-separated), timestamp within 300 s, constant-time
  comparison; a v1-only or stale delivery is refused. `evt_` ids, exactly-once inbox. Only events from source `sources` are
  applied. nginx never proxies `/internal/`.
- **CSRF:** SameSite=Lax session cookie plus an HMAC form token on every desk form.
- **XSS:** all HTML goes through `openvibe-publishing/ssr` auto-escaping; source links get
  `rel="noopener nofollow"`; helmet CSP.
- **SSRF:** News makes no outbound request to a URL from content. It calls only its configured
  Network, Sources, Events, Community and AI hosts.
- **Licensing and privacy:** see "Licensing" above; removed sources are masked everywhere public.
  The editor view shows removal reasons; the public view does not.
- **Fabrication:** no seeded or generated stories, ratings or dates; dates come from sources or an
  editor citing one; empty feeds use a real time; JSON-LD omits unknown fields.
- **Abuse:** rate limits on `/auth`, `/edit`, `/clusters`, `/api/v1` and the comment form, in
  Express and in the nginx reference.
- **Comments:** Community owns the text and its moderation; News renders it through the same
  auto-escaping and stores only the thread id. The comment form needs a signed-in member and the
  form token, is rate-limited, and is refused for a story that is not open for discussion.
- **Known gaps:** no per-story Media attachments; the Sources registry name is cached and not
  refreshed after the first successful read; the Network does not hold News' two Community grants
  yet, so story pages say comments are unavailable until they are added.

## Development

```bash
fnm exec --using=22.22.1 npm install
fnm exec --using=22.22.1 npm test          # temp databases and in-process mocks, no network
fnm exec --using=22.22.1 npm run dev       # http://localhost:4820 (set OV_OAUTH_CLIENT_SECRET to sign in)
```

## Deploy (for the lead)

1. **Code and config:** put the code at `/opt/openvibe.news` and run `npm ci --omit=dev` on Node 22.
   Create `/etc/openvibe/news.env` (0600) from `.env.example` with `OV_OAUTH_CLIENT_SECRET`,
   `NEWS_EDITORS`, `NEWS_FORM_SECRET`, `NEWS_EVENTS_SECRET` (`openssl rand -hex 32`),
   `EVENTS_URL=http://127.0.0.1:4300`, `OV_SOURCES_INTERNAL_URL=http://127.0.0.1:4720`,
   `BASE_URL=https://openvibe.news`, `OV_COMMUNITY_INTERNAL_URL=http://127.0.0.1:4200`, and
   optionally `OV_AI_INTERNAL_URL`.
2. **Network:** create (or give a secret to) the OAuth client `news` with redirect
   `https://openvibe.news/auth/callback`, and add the grants listed above.
3. **Search:** make sure `news` is in `SEARCH_EVENT_OWNERS`.
4. **systemd:** install `deploy/systemd/openvibe-news.service` (port 4820, `StateDirectory=openvibe-news`).
5. **nginx:** install `deploy/nginx/openvibe.news.conf`. `/metrics` and `/internal/` are never proxied.
6. **Seed and subscribe:** `npm run seed` (topics only; also done on boot), then
   `npm run subscribe` (creates the `sources.item.*` and `sources.fetch.failed` subscriptions to
   `http://127.0.0.1:4820/internal/events`). The cursor pull starts on its own.
7. **Sources:** News shows nothing until a news source is enabled in OpenVibe.Sources (terms
   verified by a person) and an editor publishes a story.
8. **Contracts:** done: the capabilities and manifest are released in openvibe-contracts v0.21.0,
   and CI's contracts check runs against them.
9. **Launch:** in the same release, remove `openvibe.news` from OpenVibe.Sites and flip the Network
   hub entry (see the launch rule above).

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
