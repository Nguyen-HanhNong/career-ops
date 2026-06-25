# Mode: mark-apply — Mark offers as Applied

Flip one or more evaluated offers to the canonical `Applied` status in
`data/applications.md`, after the user has manually submitted the
application. This is a status UPDATE of existing rows — never a new entry.

## Invocation

```
/career-ops mark-apply <reportNum> [<reportNum> ...]
```

`$mode` arrives as `mark-apply 1453 1464 ...`. Everything after `mark-apply`
is a space-separated list of **report numbers** — the numbers shown in
scan/pipeline summaries and in `reports/` filenames (e.g. `1453-affirm-...`).
These are matched against the Report-link column, NOT the tracker's `#`
column (the two can differ).

Optional flags the user may include, passed straight through to the script:
- `--date YYYY-MM-DD` — the apply date to record (default: today)
- `--note "text"` — extra context (referral, used tailored PDF, etc.)

## Workflow

1. Parse the report numbers (and any `--date` / `--note`) from `$mode`.
   If no numbers were given, show the invocation example and stop.
2. Run the deterministic script:
   ```bash
   node mark-applied.mjs <nums...> [--date ...] [--note "..."]
   ```
   The script matches by report number, sets Status → `Applied`, leaves the
   Date column untouched, records `Applied {date}` in Notes, and is
   idempotent (rows already `Applied` are skipped). It writes only when at
   least one row changes.
3. Relay the script's per-row result to the user:
   - `✅` marked Applied (with the previous status)
   - `⏭️` already Applied (no change)
   - `❌` no row with that report number — tell the user to check the number
   - `⚠️` ambiguous (multiple rows) — ask the user which company they meant
4. After a successful change, remind the user that `Applied` offers feed
   `/career-ops followup`, which will flag when a follow-up nudge is due.

## Notes

- This mode only edits the Status/Notes of existing rows. It NEVER adds rows
  (new entries go through the TSV + `merge-tracker.mjs` flow) and never edits
  any report or CV file.
- To preview without writing, the user (or you) can add `--dry-run`.
- Canonical states live in `templates/states.yml`; `Applied` means the
  application was submitted.
