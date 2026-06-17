# Mode: pipeline — URL Inbox (Second Brain)

Process job URLs stored in `data/pipeline.md`. The user adds URLs at any time and then executes `/career-ops pipeline` to process them all.

## Workflow

> **Discovery vs. evaluation:** This mode only *evaluates* URLs already sitting in `data/pipeline.md`. Finding new jobs — including pulling LinkedIn / Indeed / Wellfound **job-alert emails from Gmail** — is the `scan` mode's job (see `modes/scan.md`, Nivel 4). `scan` resolves each alert to a concrete URL and drops it into the "Pending" section; this mode then picks it up via the normal loop below, with no special-casing.

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

   **Model selection by volume (Claude Code only):** Before launching the subagents, count the pending URLs and set the Agent tool's `model` parameter accordingly, to conserve quota on large batches. This is the same volume→model mapping the standalone `batch/batch-runner.sh` uses (its `select_model_by_volume`), so behavior is consistent across both paths:

   | Pending URLs | `model` | Why |
   |--------------|---------|-----|
   | < 30 | `opus` | Strongest reasoning; volume is small enough that cost is fine |
   | 30–60 | `sonnet` | Balanced quality/cost for a medium batch |
   | > 60 | `haiku` | Cheapest; preserves the plan's quota on a large backlog |

   Apply the chosen `model` to every pipeline subagent you spawn for this run, and tell the user which model was selected and why (e.g. "72 pending URLs → using haiku to stay within quota"). An explicit user request in the conversation (e.g. "use sonnet for this") always overrides the automatic choice. If the Agent tool is unavailable (non–Claude Code platform), ignore this step and process sequentially in the main context.
4. **At the end**, show summary table:

```
| # | Company | Role | Score | PDF | Recommended action |
```

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
- **LinkedIn**: A bare `linkedin.com/jobs/view/{id}` URL is login-walled. Run it through the LinkedIn resolution ladder — company ATS → guest endpoint → punt (documented in `modes/scan.md`, Nivel 4) — instead of evaluating the walled page directly. Only if every rung fails do you mark `[!]` and ask the user to paste the text.
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
