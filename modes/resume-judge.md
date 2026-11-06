# Mode: resume-judge — LLM-as-Judge for Tailored Resumes

An **independent critic** that scores a generated resume against the job description and the candidate's `cv.md`, then drives a generate → judge → revise loop until the resume clears a quality bar. The judge's only job is to evaluate; it never writes `cv.md` and never invents content.

## When it runs

- **Automatically** as the final step of the BYO `latex`/`pdf` pipeline when `config/profile.yml → cv.judge: true`. Because resume generation is gated by `auto_pdf_score_threshold`, the judge only ever runs on the handful of strong matches that actually get a resume — **never across the whole pipeline.**
- **On demand:** `/career-ops resume-judge {report-basename}` to judge (and optionally revise) an existing resume in `output/`.

## Why a separate agent (Claude Code)

Run the judge as its **own Agent with fresh context** — never let the same agent that wrote the resume also grade it (it will rationalize its own choices). Suggested model: `sonnet` for iteration passes, `opus` for the final verdict on a top-priority role. On platforms without subagents, run the judge as a distinct, clearly-delimited reasoning pass with the rubric below, judging only the artifact (not the generation transcript).

## Inputs

1. **JD** — from the evaluation report (`reports/{basename}.md`, Block A/B) or the pipeline context. If absent, ask for it.
2. **`cv.md`** — the ground truth for what the candidate has actually done. Every resume claim must trace back here.
3. **The generated resume** — read `output/{basename}.tex` (text is sufficient; no need to render).
4. **`config/profile.yml`** — `target_roles`, comp/location, `cv.judge_threshold`, `cv.judge_max_iters`.

## Rubric (score each 0–2, total /10)

| # | Criterion | What a 2 looks like |
|---|-----------|---------------------|
| 1 | **JD coverage** | The JD's must-have skills/requirements are visibly represented in summary + first bullets + skills. |
| 2 | **Relevance & ordering** | Most JD-relevant roles/bullets lead; weak or off-topic bullets are demoted or cut. |
| 3 | **Truthfulness** *(hard gate)* | Every claim traces to `cv.md`/`article-digest.md`. No invented skills, metrics, titles, or scope inflation. |
| 4 | **Impact clarity** | Bullets are specific and quantified (metric, tool, scale) rather than vague duty statements. |
| 5 | **ATS & style** | Standard sections, parseable, **no em/en dashes, no AI clichés** (`leveraged`, `spearheaded`, `passionate about`, `robust`, `seamless`…), varied sentence openings. |

**Truthfulness is a gate, not just a score.** Any fabrication = **automatic FAIL** regardless of total, and it must be listed explicitly with the offending line. The fix is always to revert to what `cv.md` supports, never to invent support.

## Output (the judge returns)

```
Resume Judge — {company} {role} (report {NNN})
Score: {total}/10   Verdict: {PASS | REVISE | FAIL-truthfulness}
  1 JD coverage:      {0-2}  — {one line}
  2 Relevance:        {0-2}  — {one line}
  3 Truthfulness:     {0-2}  — {PASS or list every unsupported claim}
  4 Impact clarity:   {0-2}  — {one line}
  5 ATS & style:      {0-2}  — {one line}

Required edits (specific, apply verbatim where possible):
  - {bullet locator} → {suggested rewrite, traceable to cv.md}
  - ...
```

- **PASS** when `total ≥ cv.judge_threshold` (default 8) AND truthfulness == 2.
- **REVISE** when `total < threshold` and no fabrication — emit concrete edits.
- **FAIL-truthfulness** when any fabrication is present — emit the offending lines + the cv.md-supported correction; this blocks PASS at any score.

## The loop (generator side)

1. Generate the tailored resume (BYO `latex` pipeline) → `output/{basename}.tex` → compile.
2. Run the judge agent on it.
3. If **PASS** → done; show the user the resume + the judge's verdict.
4. If **REVISE/FAIL** and iterations `< cv.judge_max_iters` (default 2):
   - Apply the judge's edits to `output/{basename}.tex` (bullet text only — never touch format; keep all rewrites traceable to `cv.md`; no em dashes).
   - Recompile and re-judge. Increment the counter.
5. If still not passing at `judge_max_iters` → present the **best** version plus the judge's remaining concerns, and let the user decide. Never silently ship a resume that failed the truthfulness gate — surface it.

## Guardrails

- The judge **evaluates only**; it does not edit `cv.md`, `cv-user.tex`, reports, or the tracker.
- Keep it cost-aware: default 2 iterations. A resume that needs more than that usually signals a genuine fit gap worth telling the user about, not more polishing.
- Style rules (no em dashes, no clichés) match `modes/_shared.md` and `modes/latex.md`. `generate-latex.mjs` also strips literal em/en dashes at compile time, but the judge should still flag them so they're fixed in the source text.
- The judge's verdict is advisory to the user, never an auto-submit trigger. Applications still require explicit user review (see Ethical Use in AGENTS.md).
