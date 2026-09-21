# OpenVibe.News

> Source-backed stories: clustered coverage, cited summaries, perspectives and timelines.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.news`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.7.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

A publication product, not an autonomous headline generator: normalised source items, story clusters, editorial/publication state, perspective groupings and timelines with full provenance.

## Owns

- `news_topics`, `news_source_items`, `news_story_clusters`, `news_stories`, `news_story_revisions`, `news_story_sources`, `news_perspectives`, `news_timeline_entries`, `news_editorial_flags`

## Does not own

- source adapter policy (shared source registry)
- discussion (Community)

## Planned surfaces

- ingest with visible fetch/parse status, dedupe/cluster, factual fields kept separate from synthesis, cited summaries, perspective views, timelines, human review / noindex states

## Data (authority tables / families)

- see above

## Capabilities and events

- `news.story.create|revise|publish`, `news.cluster.read`, `news.source.attach`, `news.timeline.update`

Events: ``news.source.ingested|failed``, ``news.cluster.updated``, ``news.story.published|updated|retracted``

## Depends on

- source registry
- OpenVibe.AI
- Search
- OpenVibe.Community
- OpenVibe.Events

## Acceptance (must be true before "done")

- every published synthesized claim traces to source records
- failed ingestion never fabricates replacement facts
- source correction/removal triggers a revision
- licensed/private material never leaks into public text

## Bootstrap / extraction source

No current implementation; Wave 15 after the Sources/AI/publishing primitives exist.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
