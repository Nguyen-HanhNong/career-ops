# Mode: cleanup — Remove Old Reports & Generated Resumes

## Trigger

User asks to remove old reports, clean up the reports folder, delete reports not from today, **or clear the generated resume PDFs/HTML in `output/`**.

## Targets (pick from the argument)

This mode cleans one of two locations. Resolve the target from the sub-argument (`$mode` after `clean`/`clear`):

| Argument | Target | What it deletes |
|----------|--------|-----------------|
| _(none)_ or `reports` | **Reports** | Old report `.md` files in `reports/` not dated today |
| `resumes`, `output`, `pdf`, `cv` | **Resumes** | Generated `.pdf` + `.html` resume files in `output/` |
| `all` | **Both** | Runs the reports cleanup *and* the resumes cleanup |

`/career-ops clear` is an alias that defaults to the **Resumes** target (still accepts the same sub-arguments, e.g. `clear reports`, `clear all`).

The **Reports** flow is below; the **Resumes** flow is in "Clearing generated resumes" further down. For `all`, run both flows (one confirmation each, or a single combined confirmation listing both groups).

---

## Reports target

## What This Mode Does

Deletes all report files in `reports/` whose date does not match today's date (`YYYY-MM-DD`).

Report filenames follow the pattern: `{###}-{company-slug}-{YYYY-MM-DD}.md`

## Steps

### 1. Identify today's date

Use the `currentDate` from context (format: `YYYY-MM-DD`).

### 2. List all reports

Read `reports/` and separate files into two groups:
- **Keep**: filename ends with `-{today}.md`
- **Delete**: everything else

### 3. Show the user what will be deleted

Before deleting anything, present a summary:

```
Reports to DELETE (not from {today}):
  - 001-acme-2026-05-10.md
  - 002-globex-2026-05-14.md
  ... (N files)

Reports to KEEP (from today, {today}):
  - 245-glean-2026-05-17.md
  ... (M files)

Proceed? (yes / no)
```

If there are no files to delete, say so and stop.

### 4. Wait for confirmation

**NEVER delete files without explicit user confirmation.** Stop and wait for "yes" or equivalent.

### 5. Delete the files

Once confirmed, delete the files in the "Delete" list.

**Linux / macOS (bash):** delete every report whose filename does not end with
`-{today}.md` (keeps `.gitkeep` and any non-report files):

```bash
today={today}
find reports -maxdepth 1 -name '*.md' ! -name "*-${today}.md" -delete
```

Or delete specific files individually:

```bash
rm -f "reports/{filename}"
```

**Windows (PowerShell):**

```powershell
$today = '{today}'
Get-ChildItem 'reports/*.md' |
  Where-Object { $_.Name -notmatch "-$today\.md$" } |
  Remove-Item -Force
```

### 6. Mark cleaned reports in the tracker

Immediately after deleting, sync the tracker so each row shows whether its
report file is still on disk:

```bash
node mark-cleaned-reports.mjs
```

This annotates the **Report** column in `data/applications.md`:
- report file still on disk → no marker (e.g. `[845](../reports/845-...md)`)
- report file removed → append ` 🧹` (e.g. `[750](../reports/750-...md) 🧹`)

The script is idempotent and disk-driven: it adds 🧹 to entries whose file is
gone and removes 🧹 from any report that has since been regenerated. It only
touches the Report cell — entry numbers, scores, statuses, and notes are left
untouched. The `[num](path)` link itself is preserved (the marker goes after
it), so it stays a useful record of the report's number and slug for later
regeneration, and all tracker tooling keeps parsing it.

### 7. Confirm

After deleting and marking, report:
```
Deleted {N} old report(s). {M} report(s) from today remain.
Tracker updated: {N} entr(ies) marked cleaned (🧹).
```

---

## Clearing generated resumes (Resumes target)

Deletes the program-generated resume artifacts in `output/`: tailored CV **`.pdf`** and **`.html`** files (e.g. `965-lyft-software-engineer-backend-2026-06-09.pdf`, `957-speak-backend-cv.html`). These are disposable build artifacts — `output/` is gitignored — and any of them regenerates on demand via `/career-ops pdf {company-slug}` or `/career-ops latex`.

### 1. List what will be deleted

Count and list the `.pdf` and `.html` files in `output/` (top-level only; never recurse into subfolders). Always preserve `output/.gitkeep`.

```bash
ls output/*.pdf output/*.html 2>/dev/null
```

### 2. Show the user

```
Generated resumes to DELETE from output/:
  - 43 .pdf file(s)
  - 34 .html file(s)
  (e.g. 965-lyft-...-2026-06-09.pdf, 957-speak-backend-cv.html, ...)

Kept: output/.gitkeep, and any .tex sources (unless you ask to include them).

Proceed? (yes / no)
```

If there are no matching files, say so and stop.

**`.tex` note:** by default the tailored `.tex` *sources* are KEPT (they hold the per-job bullet edits and are the cheapest way to recompile). Only include them if the user explicitly asks to clear `.tex` too (then add `-o -name '*.tex'` below).

### 3. Wait for confirmation

**NEVER delete without explicit confirmation.** Stop and wait for "yes" or equivalent.

### 4. Delete

```bash
# Deletes top-level .pdf and .html in output/; .gitkeep and .tex are untouched.
find output -maxdepth 1 -type f \( -name '*.pdf' -o -name '*.html' \) -delete
```

To also clear `.tex` sources (only if the user asked): add `-o -name '*.tex'` inside the parentheses.

### 5. Confirm

```
Cleared {N} generated resume(s) from output/ ({P} .pdf + {H} .html). .tex sources kept.
```

**Tracker note:** clearing resumes does **not** edit `data/applications.md`. The PDF ✅/❌ column records whether a tailored CV was produced for that role and stays a useful "regenerate me" signal; the file is rebuildable via `/career-ops pdf {slug}`. Likewise, report `**PDF:**` pointers still name the (now-regenerable) path. This mirrors how the Reports target keeps tracker rows after deleting report files.

---

## Rules

- **NEVER delete without user confirmation.** Always show the list first.
- **Resumes target only touches `output/`** (top-level `.pdf`/`.html`, plus `.tex` only if explicitly requested). Never deletes from `reports/`, `data/`, or `jds/`, and never edits the tracker.
- Only delete files in `reports/`. The **only** tracker change allowed is the
  🧹 marker on the Report column via `mark-cleaned-reports.mjs` (step 6) —
  never edit entries, scores, statuses, or notes, and never remove rows.
  Deleted reports keep their tracker entries; the marker just records that the
  file is no longer on disk.
- If the user wants to delete reports from a specific date range instead of "not today", adapt the filter accordingly and still show the list before deleting. Run step 6 afterward regardless.
- `verify-pipeline.mjs` recognizes the 🧹 marker: marked-cleaned reports are
  reported as acknowledged (not warnings), while an absent report with no marker
  is flagged so you can re-run `mark-cleaned-reports.mjs` or regenerate it.
