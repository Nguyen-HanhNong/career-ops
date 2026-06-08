# Mode: cleanup — Remove Old Reports

## Trigger

User asks to remove old reports, clean up the reports folder, or delete reports not from today.

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

## Rules

- **NEVER delete without user confirmation.** Always show the list first.
- Only delete files in `reports/`. The **only** tracker change allowed is the
  🧹 marker on the Report column via `mark-cleaned-reports.mjs` (step 6) —
  never edit entries, scores, statuses, or notes, and never remove rows.
  Deleted reports keep their tracker entries; the marker just records that the
  file is no longer on disk.
- If the user wants to delete reports from a specific date range instead of "not today", adapt the filter accordingly and still show the list before deleting. Run step 6 afterward regardless.
- `verify-pipeline.mjs` recognizes the 🧹 marker: marked-cleaned reports are
  reported as acknowledged (not warnings), while an absent report with no marker
  is flagged so you can re-run `mark-cleaned-reports.mjs` or regenerate it.
