# AGENTS.md — OpenVibe.News

## Project Overview

OpenVibe.News is the network's source-backed news product: it ingests items from OpenVibe.Sources, dedupes and clusters
them deterministically, and lets editors open a story from a cluster, write cited paragraphs, attach a timeline and
perspectives, publish revisions, and correct or retract them in public. Beside editor-written stories it has AI briefs,
tone/perspective comparisons scheduled by readers, and `/live` breaking coverage. A story is indexable only through
an explicit gate.

- **Domain:** `openvibe.news` · **Port:** 4820 · **Service id:** `news`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey 9
  optional for shared limits.
- **Read first:** [README.md](README.md) (long and authoritative), [STATUS.json](STATUS.json), [.env.example](.env.example).

**Network context:** identity and editor names are OpenVibe.Network (OAuth client `news`, PKCE). Source items are
OpenVibe.Sources (`sources.item.read`; optionally `sources.source.read`); News **never fetches a site itself**. Story
comments are OpenVibe.Community threads, referenced by id and read on every render — never copied. Drafts come from
OpenVibe.AI (`ai.run.create`, optional). Search consumes `news.index_document.*` through Events. Events delivery is
OpenVibe.Events.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared/publishing pinned by tag)
npm run dev                    # http://localhost:4820 (OV_OAUTH_CLIENT_SECRET to sign in)
npm start                      # node server/index.js
npm test                       # every test/*.test.js on temp databases with in-process mocks, no network
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm run seed                   # topics only (also done on boot)
npm run subscribe              # creates the sources.item.* / sources.fetch.failed subscriptions
npm test -- stories            # only test files whose name contains the word
node --check <file.js>         # syntax check (no linter configured)
```

No build step: pages are server-rendered; CSS only under [public/css/](public/css/) (`news.css`, `briefs.css`). Every
page and form works without JavaScript.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — listener, outbox relay, Sources pull worker, telemetry and graceful
  stop. `NEWS_DRILL` keeps boot-time work off.
- **App factory:** [server/app.js](server/app.js) — CSP, SSO/session, `/auth`, `/internal/events`, static/`/shared`,
  public pages + editor desk + API + discovery, 404/error handler.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production `/etc/openvibe/news.env`.
- **Domain:** [server/domain/](server/domain/) — `source-items.js` (ingest, dedupe), `clusters.js`, `stories.js`,
  `publication.js` (publish/correct/retract), `briefs.js`, `home.js`, `reading.js`, `discussion.js`, `topics.js`,
  `review-kind.js`, `access.js`, `topic-match.js`; ingest worker [server/worker.js](server/worker.js).
- **HTTP:** [server/http/public.js](server/http/public.js) (public pages), [server/http/editor.js](server/http/editor.js)
  (the desk), [server/http/api.js](server/http/api.js), [server/http/discovery.js](server/http/discovery.js),
  [server/http/events.js](server/http/events.js), [server/http/actor-limits.js](server/http/actor-limits.js).
- **Clients:** [server/clients/](server/clients/) — `ai.js`, `community.js`, `network.js` (service tokens; no outbound
  fetch from a page or a user URL).
- **Auth/forms:** [server/auth/viewer.js](server/auth/viewer.js), [server/auth/capabilities.js](server/auth/capabilities.js)
  (delegates to `openvibe-contracts` capabilities), [server/auth/forms.js](server/auth/forms.js) (CSRF form tokens).
- **Rendering:** [server/render/](server/render/) — `layout.js`, `pages.js`, `editor.js`, `home.js`, `briefs.js`,
  `short.js`; Markdown twins via [server/agent-pages.js](server/agent-pages.js), [server/agent-descriptor.js](server/agent-descriptor.js).
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/). Core: `news_topics`, `news_source_items`,
  `news_story_clusters`, `news_stories`, `news_story_revisions`, `news_story_sources`, `news_perspectives`,
  `news_timeline_entries`, `news_editorial_flags`, `news_story_citations`, `news_story_reviews`, `news_story_drafts`,
  `news_story_revision_purges`, `news_index_revisions`, `news_story_discussion_refs`, `news_cluster_audit`,
  `news_ingest_runs`, `news_ingest_cursor`, `news_source_status`, `news_cluster_briefs`, `news_brief_reviews`,
  `news_share_defaults`, sharing tables, `event_outbox`, `idempotency_receipts`, `subject_projections`,
  `account_data_events`, `telemetry_samples`.
- **Deploy:** [deploy/systemd/openvibe-news.service](deploy/systemd/openvibe-news.service) (127.0.0.1:4820,
  `/etc/openvibe/news.env`) and [deploy/nginx/openvibe.news.conf](deploy/nginx/openvibe.news.conf). `sudo ovhost deploy
  news` (git-checkout at `/opt/openvibe.news`, database `ov_news`; migrations only add tables/columns). Run `npm run
  seed` and `npm run subscribe` on first install; `/internal/` and `/metrics` are never proxied.

## Ownership and Boundaries

News owns its source-item copies, clusters and their audit, stories, immutable revisions, the source table,
perspectives, timeline, editorial flags, briefs/reviews, the index sequencer, cursor/run/status rows and share rows. It
does **not** own source adapters or the registry (Sources), comment threads (Community), AI generation (AI), the search
index (Search), accounts (Network) or event delivery (Events).

Licensing is a hard rule: keep only headline, canonical URL, outlet, authors, `published_at`, the licence/terms notes
and — only when those notes allow short summaries — a summary of at most `NEWS_SUMMARY_MAX_CHARS` (280). Never read or
store an article body, and never show a source summary in feeds, Search documents or events. A removed item's summary
is dropped at once.

## Auth and Capabilities

- Editors are browser/app users whose subject is in `NEWS_EDITORS` or who are Network admins; the editor desk is
  private and noindex. Service tokens use audience `openvibe.news`, one capability per route, and put the editor they
  act for in `X-OV-Subject`.
- Capabilities: `news.story.create|read|revise|publish|retract`, `news.cluster.read|manage`,
  `news.source.attach`, `news.timeline.update`, `news.perspective.update`, `news.topic.manage`,
  `news.review.ai_editor`. Match grants with `openvibe-contracts`' capability rule, not a hand-rolled string check.
- Outbound: `sources.item.read` (and optionally `sources.source.read`), `events.event.publish`,
  `events.subscription.manage`, `identity.subject.resolve`, `community.comment.write|moderate`,
  `ai.run.create` (namespace `news.*`, optional).
- Form posts carry `NEWS_FORM_SECRET` tokens; cookie writes are same-origin. Never bypass the form-token check.
- Errors are structured with stable codes (`story.unsourced`, `story.stale`, upstream 503 for Events to retry, …).

## Pages, Feeds and API

Pages: `/`, `/topics`, `/topics/:slug`, `/stories/:slug` (+ `.json`), `/briefs`, `/briefs/:cluster`, `/live`,
`/edit`, `/edit/stories/:id`, `/clusters/:id`, `/admin/review`, `/auth/*`.
Discovery: `/feed.xml`, `/atom.xml`, `/feed.json` (and per-topic variants), `/sitemap.xml` →
`/sitemaps/stories.xml`, `/sitemaps/topics.xml`, `/sitemaps/briefs.xml`, `/robots.txt`, `/llms.txt`, `/llms-full.txt`.
`/internal/events` is loopback; `/api/health`, `/api/ready`, `/release.json`, `/metrics` are machine endpoints.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter. Async access through `openvibe-sdk/db`.
- Revisions are immutable and use optimistic concurrency (412 on a stale base). Source numbers `[n]` are never reused;
  a paragraph must cite numbers present in the source table.
- Publishing is refused when a revision has no sources, cites a detached/removed source, or is AI-generated/assisted
  without a person's review. Retraction is final: keep the URL, show the notice, noindex, drop from sitemaps/Search.
- Indexability is the `openvibe-publishing/seo` gate with explicit reasons: at least `NEWS_MIN_INDEPENDENT_SOURCES`
  (default 2) live independent sources and at least 40 words; unsupported claims, retraction, an editor's noindex and
  unreviewed AI output are never indexable. Independent sources collapse shared source keys, publisher domains,
  outlets and duplicates; the relation is transitive.
- AI briefs label themselves as AI on every page, cite paragraphs and drop uncited claims; a brief is noindex until a
  person reviews it and it has enough independent outlets, and a remake after the cluster changes waits again.
- Caching: published anonymous pages `public, max-age=60`; signed-in/desk/preview/refusal/API `private, no-store` with
  `X-Robots-Tag`; feeds/sitemaps five minutes, never per viewer. HTML/JSON vary on `Cookie` and `Authorization`.
- JSON-LD uses real fields only; missing ones are omitted. IndexNow is off without `INDEXNOW_KEY` and never pings a
  draft/private/noindex page.
- CSP: add origins to `helmet` in [server/app.js](server/app.js); no inline script beyond what the policy allows.
- Phone first: public pages fit 390 px; forms work without JS. No Font Awesome; use the shared glyphs.
- "Calm reduces, only Off removes": previews/teasers reduce, only the explicit retraction/unpublish path removes.

## Key Pitfalls

- **Never fetch a source site.** Ingest only through Sources (webhook or cursor pull); an item apply is idempotent on
  (Sources item id, revision). Failure is a recorded state and a 503 to Events, never a made-up item.
- **Dedupe and clustering are deterministic and stored** — same normalised URL/content hash/near-duplicate headline;
  clusters by shared entities/terms in a 72 h window. Do not replace either with an AI guess; merges/splits must be
  audited and reversible.
- **Upstream change:** a cited source revised/removed opens a flag and a pending same-text revision; the published
  revision stays as it was, the page carries a notice, a removed source's headline/summary/link leave at once, and
  the story becomes noindex `unsupported_claims` until an editor publishes the fix.
- **Editor desk is private/noindex**; a form token is required and the same limits apply as the API.
- **AI**: the stub provider's output must never be shown; claims the model did not cite are dropped and listed. Briefs
  and `/live` stay noindex by default.
- **Drill mode** (`NEWS_DRILL`) keeps the worker, outbox relay, brief timer and subscriptions off; add new timers.
- **Account deletion** removes personal rows/receipts through `/internal/events`; redelivery changes nothing.
- **Migration 0010** adds the `event_outbox` rejected partial index; keep it.

## Testing

`npm test` runs each file in its own process on temp databases with mock Sources/Events/Community/AI. The suite covers
ingest/idempotency/licensing/dedupe/clusters, story revisions/publish/retract/upstream change, briefs and reviews,
indexability/sitemaps/llms/JSON-LD/IndexNow, comments, caching/no-JS, capabilities/contracts, SSO, links, CSP, perf
budgets, sharing and account data. `npm run test:pg` for PostgreSQL. Run the narrowest file first, then the suite;
always `node --check` changed files.

## Documentation

- [README.md](README.md) — purpose, AI briefs/Live, ownership, what works, routes, discoverability, caching, events,
  capabilities/grants, acceptance, launch rule, security, limits, deploy.
- [docs/capabilities-proposal/](docs/capabilities-proposal/) and
  [docs/service-manifest-proposal.json](docs/service-manifest-proposal.json) — the released capability/manifest
  proposals.
- [seeds/topics.json](seeds/topics.json) — the only topic seed.
- [STATUS.json](STATUS.json), [.env.example](.env.example), [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).
