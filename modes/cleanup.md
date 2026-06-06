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

Once confirmed, delete each file in the "Delete" list using Bash:

```bash
powershell.exe -Command "Remove-Item 'reports/{filename}' -Force"
```

Or batch delete all old reports at once:

```bash
powershell.exe -Command "
  $today = '{today}'
  Get-ChildItem 'reports/*.md' |
    Where-Object { $_.Name -notmatch \"-$today\.md$\" } |
    Remove-Item -Force
"
```

### 6. Confirm deletion

After deleting, report:
```
Deleted {N} old report(s). {M} report(s) from today remain.
```

## Rules

- **NEVER delete without user confirmation.** Always show the list first.
- Only delete files in `reports/` — do not touch `data/applications.md`, `batch/`, or any other directory.
- If the user wants to delete reports from a specific date range instead of "not today", adapt the filter accordingly and still show the list before deleting.
- Do not modify the tracker (`data/applications.md`) — deleted reports may still have tracker entries the user wants to keep.
