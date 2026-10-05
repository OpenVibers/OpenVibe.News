# Changelog

## Unreleased

- The home page opens with what OpenVibe.News is for (plan T11, `openvibe-shared/showcase`, as Blog's home does): a hero (News you can check; Read the stories, Browse topics) and the four things a story really has today (cited paragraphs, revisions on the record, source checks, Community discussion). Page 1 only: later pages and topic pages are unchanged. The hero is the page's one h1, so the list header there is "Latest stories"; `showcase.css` is linked only on page 1. Home budgets raised as a decision (HTML 27 KB / 7.5 KB brotli, CSS 17.5 KB / 4.5 KB brotli).
- Every page is rendered through `openvibe-publishing/layout` (v1.2.0, on `openvibe-shared/shell` v2.6.0): the head, the Frame, the noscript navigation, the footer and its init come from the shared document; robots and the canonical still come from the indexability gate's decision. The shell adds `web-runtime.js`, so the home page's JS budget is raised to 5 files, 245 KB, 59 KB brotli.
- The `openvibe-publishing` v1.2.0 lock entry carries its sha512 integrity again (the bump had dropped it), and a test fails if any codeload pin loses its hash.
- `openvibe-publishing` v1.3.0 (from v1.2.0): `layout.renderDocument` now forwards `summary`, `facts`, `updated` and `url` to the shell's AI-summary block, so the home page carries the same one-line summary as `<meta name="ai-summary">` and a WebPage JSON-LD twin.
- `GET /llms-full.txt` sits beside `/llms.txt`: the same header plus one Stories section of only the indexable stories, each with its editor's opening summary as text (never a source's full article text), capped at 512 KiB.
