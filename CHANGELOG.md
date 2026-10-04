# Changelog

## Unreleased

- Every page is rendered through `openvibe-publishing/layout` (v1.2.0, on `openvibe-shared/shell` v2.6.0): the head, the Frame, the noscript navigation, the footer and its init come from the shared document; robots and the canonical still come from the indexability gate's decision. The shell adds `web-runtime.js`, so the home page's JS budget is raised to 5 files, 245 KB, 59 KB brotli.
- The `openvibe-publishing` v1.2.0 lock entry carries its sha512 integrity again (the bump had dropped it), and a test fails if any codeload pin loses its hash.
