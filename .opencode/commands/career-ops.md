---
description: career-ops command router for scan, pipeline, tracker, PDF, apply, and evaluations
agent: build
---

Route `$ARGUMENTS` using the career-ops router.

If `$1` is `scan`, run the OpenCode-compatible full scan workflow:

`node scan-full.mjs`

This is required in OpenCode because the lightweight `node scan.mjs` path only runs structured providers. The full scan wrapper also performs Playwright liveness verification, Brave WebSearch Level 3 when `BRAVE_SEARCH_API_KEY` is configured, and Gmail alert processing for LinkedIn, Indeed, and Wellfound.

For other career-ops modes, load the `career-ops` skill and follow the mode instructions from `modes/`.
