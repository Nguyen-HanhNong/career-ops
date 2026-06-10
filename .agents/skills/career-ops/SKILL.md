---
name: career-ops
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
arguments: mode # Claude Code specific
user-invocable: true
argument-hint: "[scan | deep | pdf | resume-judge | oferta | ofertas | apply | batch | tracker | pipeline | contacto | training | project | interview-prep | update | clean | clear]"
license: MIT
---

# career-ops -- Router

## Mode Routing

Determine the mode from `$mode`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `oferta` | `oferta` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `deep` | `deep` |
| `interview-prep` | `interview-prep` |
| `pdf` | `pdf` |
| `resume-judge` | `resume-judge` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |
| `update` | `update` |
| `clean` [`reports`\|`resumes`\|`all`] | `clean` (→ `modes/cleanup.md`) |
| `clear` [`reports`\|`resumes`\|`all`] | `clean` (alias; → `modes/cleanup.md`, defaults to the `resumes` target) |

**Auto-pipeline detection:** If `$mode` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `$mode` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
career-ops -- Command Center

Available commands:
  /career-ops {JD}      → AUTO-PIPELINE: evaluate + report + PDF + tracker (paste text or URL)
  /career-ops pipeline  → Process pending URLs from inbox (data/pipeline.md)
  /career-ops oferta    → Evaluation only A-F (no auto PDF)
  /career-ops ofertas   → Compare and rank multiple offers
  /career-ops contacto  → LinkedIn power move: find contacts + draft message
                          (one role, or batch: `contacto top5`, `contacto >=4.0`, `contacto 156 158`)
  /career-ops deep      → Deep research prompt about company
  /career-ops interview-prep → Generate company-specific interview prep doc
  /career-ops pdf       → PDF only, ATS-optimized CV
  /career-ops resume-judge → LLM-as-judge: score a tailored resume vs the JD + cv.md, then revise
  /career-ops training  → Evaluate course/cert against North Star
  /career-ops project   → Evaluate portfolio project idea
  /career-ops tracker   → Application status overview
  /career-ops apply     → Live application assistant (reads form + generates answers)
  /career-ops scan      → Scan portals and discover new offers
  /career-ops batch     → Batch processing with parallel workers
  /career-ops patterns  → Analyze rejection patterns and improve targeting
  /career-ops followup  → Follow-up cadence tracker: flag overdue, generate drafts
  /career-ops update    → Update career-ops system files with diff preview + compat check
  /career-ops clean     → Delete old reports from reports/ (keeps today's only)
                          (clean resumes → clear generated PDF/HTML CVs from output/; clean all → both)
  /career-ops clear     → Clear generated resume PDFs/HTML from output/ (alias of `clean resumes`)

Inbox: add URLs to data/pipeline.md → /career-ops pipeline
Or paste a JD directly to run the full pipeline.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `interview-prep`, `training`, `project`, `patterns`, `followup`, `resume-judge`, `clean`/`clear` (both load `modes/cleanup.md`)

---

## Platform Detection & Execution Strategy

**Detect calling platform:**

1. **Is Agent tool available?**
   - YES → Running in Claude Code (has Agent, Playwright, full tool suite)
   - NO → Running in Codex, OpenCode, Gemini, or other platform (direct mode execution)

**By Platform:**

### Claude Code (Agent tool available)
- **Complex modes** (`scan`, `pipeline`): Delegate to subagent for parallel tool use + model optimization
  - `scan` → use `model: "sonnet"`
  - `pipeline` → use `model: "opus"`  # high-effort model (Opus 4.8): deeper, better-sourced JD analysis
- **Simple modes**: Execute directly in main context

### Other Platforms (Codex, OpenCode, Gemini, CLI agents)
- **All modes**: Execute directly (no subagent delegation available)
- **For `scan` in OpenCode specifically**: Execute `node scan-full.mjs` for zero-token scanning + Gmail alerts
- **For other platforms**: Execute `node scan.mjs` (parsers + ATS APIs) or `modes/scan.md` logic directly

---

## Modes Delegated to Subagent (Claude Code Only)

**ONLY if Agent tool is available:**

For `scan`, `apply` (with Playwright), and `pipeline` (3+ URLs): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

**Model selection by mode:**
```
scan mode:
  Agent(
    subagent_type="general-purpose",
    model="sonnet",  # Claude Code: expensive model for discovery
    prompt="[content of modes/_shared.md]\n\n[content of modes/scan.md]",
    description="career-ops scan"
  )

pipeline mode:
  Agent(
    subagent_type="general-purpose",
    model="opus",  # Opus 4.8 (high-effort): pipeline evaluations get deeper, better-sourced analysis
    prompt="[content of modes/_shared.md]\n\n[content of modes/pipeline.md]",
    description="career-ops pipeline"
  )
```

**Non-Claude Code execution (direct mode):**
```
If Agent tool is NOT available:
  Read modes/_shared.md + modes/{mode}.md
  Execute the instructions from the loaded mode file directly
  (no subagent, no model optimization, sequential execution)
```

**OpenCode scan rule:** when running in OpenCode, `/career-ops scan` MUST execute `node scan-full.mjs` instead of plain `node scan.mjs`. `scan-full.mjs` runs the zero-token scanner with Playwright verification and then checks Gmail alert emails for LinkedIn, Indeed, and Wellfound, matching the checks Claude Code's agent workflow performs.

Execute the instructions from the loaded mode file.
