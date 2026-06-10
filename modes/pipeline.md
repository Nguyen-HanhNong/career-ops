# Mode: pipeline — URL Inbox (Second Brain)

Process job URLs stored in `data/pipeline.md`. The user adds URLs at any time and then executes `/career-ops pipeline` to process them all.

## Workflow

1. **Read** `data/pipeline.md` → search for `- [ ]` items in the "Pending" section
2. **For each pending URL**:
   a. Calculate the next sequential `REPORT_NUM` (read `reports/`, take the highest number + 1)
   b. **Extract JD** using Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch
   c. If the URL is not accessible → mark as `- [!]` with a note and continue
   d. **Execute full auto-pipeline**: Evaluation A-F → Report .md → PDF (if score >= `auto_pdf_score_threshold`) → Tracker
   e. **Move from "Pending" to "Processed"**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`

   **About the PDF gate (configurable):** Read `config/profile.yml` → `auto_pdf_score_threshold`. If the key does not exist, default to `3.0` (this mode's original gate). If the evaluation score is less than the threshold, skip PDF generation: write the report normally, show in the header `**PDF:** not generated — run /career-ops pdf {company-slug} to create on demand`, and mark PDF ❌ in the tracker. If the score is ≥ threshold, generate the PDF as usual.

   **Tuning it:** Generating a tailored PDF costs ~30–60s per entry (Playwright launch + HTML render) and produces files that often go unused — most roles score in the 2.x/3.x range and never reach the application stage. Raise `auto_pdf_score_threshold` (e.g. `4.0`) to write only the report for marginal offers and produce the PDF on demand via `/career-ops pdf {slug}`; set `0` to generate one for every offer. Both modes (Path A `/career-ops pipeline` and Path B `batch/batch-runner.sh`) read the same key, so behavior is identical regardless of which path processes an offer.
3. **If there are 3+ pending URLs**, launch agents in parallel (Agent tool with `run_in_background`) to maximize speed.
4. **At the end**, show summary table with **MANDATORY report number** in first column:

```
| # | Company | Role | Score | PDF | Recommended action |
|---|---------|------|-------|-----|-------------------|
| 156 | Google | Senior SWE | 4.2/5 | ✅ | Apply — strong match |
| 157 | Acme Corp | PM | 3.1/5 | ❌ | Review — marginal fit |
```

**CRITICAL:** The report number (`#`) MUST ALWAYS be in the first column of the summary. Sort by score descending so high-scoring roles appear first. This allows the user to quickly identify which reports to prioritize.

## Format of pipeline.md

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Intelligent JD detection from URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with all SPAs.
2. **WebFetch (fallback):** For static pages or when Playwright is unavailable.
3. **WebSearch (last resort):** Search in secondary portals that index the JD.

**Special cases:**
- **LinkedIn** (`linkedin.com/jobs/view/{jobId}`): the public page is behind a login wall, but the JD is almost always recoverable without it. **The guest endpoint is the primary source; WebSearch is only a fallback when it is blocked.** Resolve in this order:
  1. **Guest endpoint (try FIRST):** `WebFetch https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jobId}` — returns the JD HTML (title, company, location, description) plus its own status line without login for most postings.
     - **If it returns a JD and does NOT say "No longer accepting applications" → that is sufficient to evaluate. Proceed straight to evaluation.** Do NOT require a separate canonical URL, and do NOT go hunting for one to "confirm" liveness — the guest endpoint's own status is authoritative for this posting.
     - If it explicitly says **"No longer accepting applications"** / closed → mark `[!]` "posting closed" and skip (do not consume a report number).
     - If it is rate-limited/blocked (429/999) or returns no JD → go to step 2.
  2. **Fallback — WebSearch for the canonical posting** (only when step 1 gave no JD): `WebSearch "{company}" "{role}" careers` (plus an ATS variant: `{company} {role} {location} greenhouse OR lever OR ashby OR workday`). Prefer the company's own careers domain or its ATS. Take the result matching this exact role and verify live with Playwright (sequential — never 2+ Playwright ops in parallel).
  3. **URL & verification in the report:**
     - If you have a verified canonical company/ATS posting (from step 1's optional enrichment or step 2), use that URL in the report and tracker — it gives a real apply link.
     - If you only have the guest-endpoint JD, use the LinkedIn URL and add `**Verification:** guest-endpoint only` to the report header. **A guest-endpoint-only JD is a valid basis for a full A–F evaluation — never drop a live posting just because no canonical URL was found.**
     - **Do not trust a separately-resolved canonical req's "closed/filled" status over the guest endpoint's own liveness** — WebSearch frequently matches a *different, older* req at the same company. When they disagree, the guest endpoint (which is the exact posting from the inbox) wins.
  4. Only mark `[!]` "no JD found — paste manually" if the guest endpoint is blocked AND WebSearch finds no live canonical posting (common for staffing agencies and tiny generic shops). The same guest-endpoint→WebSearch flow applies to Indeed alert items (see `modes/scan.md` Level 4).
- **PDF**: If the URL points to a PDF, read it directly with the Read tool
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic numbering

1. List all files in `reports/`
2. Extract the number from the prefix (e.g., `142-medispend...` → 142)
3. New number = maximum found + 1

## Source synchronization

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If there is a desynchronization, warn the user before continuing.
