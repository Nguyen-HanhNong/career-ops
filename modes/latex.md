# Mode: latex — LaTeX/Overleaf CV Export

Export a tailored, ATS-optimized CV as a `.tex` file and compile it to PDF via `tectonic` or `pdflatex`.

## Template source: bundled vs. bring-your-own (CHECK FIRST)

Before doing anything else, read `config/profile.yml` → `cv.latex_source`.

- **If `cv.latex_source` is set** (e.g. `cv-user.tex`) → **bring-your-own (BYO) path**. The user's own `.tex` is the format source of truth. Tailor it **in place**: change only the bullet/summary *text*; leave the document class, preamble, custom macros, colors, spacing, and section order **byte-for-byte unchanged**. Use the **BYO Pipeline** below and compile with `--byo`.
- **If `cv.latex_source` is absent** → **bundled path**. Generate from `templates/cv-template.tex` using the placeholder substitution documented later in this file. Use the **Bundled Pipeline** below.

**Content always comes from `cv.md`.** The template choice only controls *layout*. Never invent skills or metrics in either path (same ethical rules as `modes/pdf.md`).

## BYO Pipeline (when `cv.latex_source` is set)

1. Read `cv.md` (content source of truth) + `config/profile.yml` + `cv.latex_source` (the user's `.tex`).
2. Get the JD (text or URL; resolve LinkedIn via the guest endpoint per `modes/pipeline.md` if needed).
3. Extract 15-20 JD keywords; detect archetype + JD language.
4. **Determine the output basename `{REPORT_BASENAME}`** (see "Output naming" below) — it mirrors the evaluation report so the CV sorts next to its report.
5. **Copy** the user's `.tex` to `output/{REPORT_BASENAME}.tex`. Work on the copy — never modify `cv.latex_source` itself.
6. **Edit only the bullet text** inside `\resumeItem{...}` (and the header summary line if one exists), rewording existing achievements with JD vocabulary and reordering bullets within each role by JD relevance. Do NOT touch macro definitions, `\section` headers, geometry, fonts, or colors. Escape any new special chars for LaTeX (see "LaTeX Escaping" below).
   - **No em dashes / no AI tells.** Write like the candidate, not like a model. Never use em dashes (`—`) or en dashes (`–`) in bullet prose — use a comma, period, or parentheses instead. Avoid the clichés in `modes/_shared.md` (`leveraged`, `spearheaded`, `passionate about`, etc.). Keep sentences plain and concrete. (`generate-latex.mjs` also strips any literal em/en dashes at compile time as a safety net, since a literal em dash is dropped by tectonic and merges words — but don't rely on it; just don't write them.)
7. **Set `\location`**: if the template uses `\location` (often left commented out), write an **active** `\def\location{City, Region}` immediately before `\begin{document}`. This is the **candidate's** displayed location, so it must be truthful — use `cv.latex_default_location` from profile.yml (the candidate's real location/target metro). Only use the role's city if the candidate genuinely lives there or is relocating. (The validator flags `\location` used-but-undefined.)
8. Optionally uncomment/select relevant Projects the template ships commented out, if they strengthen the match for this JD.
9. Compile: `node generate-latex.mjs --byo output/{REPORT_BASENAME}.tex output/{REPORT_BASENAME}.pdf`
   - `--byo` relaxes the bundled-template structural validation (the user's macros/section names differ) and tectonic auto-strips XeTeX-incompatible bits (`\pdfgentounicode`, `\input{glyphtounicode}`, `\usepackage{pdfx}`). Stripping `pdfx` drops PDF/A metadata only — layout and the ATS-readable text layer are unchanged. For true PDF/A, compile with `pdflatex` (e.g. Overleaf).
10. **Judge & revise (if `config/profile.yml → cv.judge: true`, default):** run the **independent** judge from `modes/resume-judge.md` on `output/{REPORT_BASENAME}.tex` — in Claude Code, as a **separate Agent with fresh context** (never the same agent that wrote it). If the verdict is REVISE/FAIL and iterations remain (`cv.judge_max_iters`, default 2), apply the judge's edits to the bullet text (format untouched, every change traceable to `cv.md`, no em dashes), recompile, and re-judge. Stop on PASS or at max iterations; if it never passes, surface the judge's remaining concerns to the user rather than shipping silently.
11. Report: .tex path, .pdf path, file sizes, keyword coverage %, which bullets were reworded, and the judge's final score/verdict.

### Output naming (`{REPORT_BASENAME}`)

Tailored CVs share the **basename of their evaluation report** — `{NNN}-{company-slug}-{YYYY-MM-DD}` — differing only by extension (`.tex`/`.pdf` vs the report's `.md`). This is the same scheme the auto-pipeline already uses, so a report and its CV sort together in a directory listing.

- **If an evaluation report already exists** for this company+role (look in `reports/` for `{NNN}-{company-slug}-{date}.md`) → reuse its exact basename. The date stays the report's date, not today's.
- **If no report exists yet** → run the evaluation first (auto-pipeline / `oferta`) so a report and number exist, then name the CV to match. If generating a CV truly standalone, compute `{NNN}` as `max(report numbers in reports/) + 1`, build `{company-slug}` from the company + role, and use today's date.
- Do **not** use the old `cv-{candidate}-{company}-{date}` name. Both `.tex` and `.pdf` go in `output/`.

## Bundled Pipeline (when `cv.latex_source` is absent)

1. Read `cv.md` as source of truth
2. Read `config/profile.yml` for candidate identity and contact info
3. Ask the user for the JD if not already in context (text or URL)
4. Extract 15-20 keywords from the JD
5. Detect JD language → CV language (EN default)
6. Detect role archetype → adapt framing
7. Rewrite Professional Summary injecting JD keywords (same rules as `pdf` mode — NEVER invent skills)
8. Select top 3-4 most relevant projects for the offer
9. Reorder experience bullets by JD relevance
10. Inject keywords naturally into existing achievements
11. Generate the `.tex` file using `templates/cv-template.tex`
12. Write to `output/{REPORT_BASENAME}.tex` (see "Output naming" above — same `{NNN}-{company-slug}-{date}` basename as the evaluation report)
13. Run: `node generate-latex.mjs output/{REPORT_BASENAME}.tex output/{REPORT_BASENAME}.pdf`
14. Report: .tex path, .pdf path, file sizes, section count, keyword coverage %

**Requires:** `tectonic` (preferred — `brew install tectonic`, auto-downloads packages) or `pdflatex` (MiKTeX / TeX Live) on PATH.

## Template Placeholders

The template at `templates/cv-template.tex` uses `{{PLACEHOLDER}}` syntax:

| Placeholder | Source |
|-------------|--------|
| `{{NAME}}` | `profile.yml → candidate.full_name` |
| `{{CONTACT_LINE}}` | Phone / City, State / Visa status — built from profile.yml |
| `{{EMAIL_URL}}` | Raw email for `mailto:` URL — must not be LaTeX-escaped (from profile.yml) |
| `{{EMAIL_DISPLAY}}` | Escaped email for display text — LaTeX-special chars like `_` must be escaped, e.g. `first\_name@example.com` |
| `{{LINKEDIN_URL}}` | Full URL with scheme for `\href{}`: e.g. `https://linkedin.com/in/username`. If `profile.yml` stores a bare host+path (no scheme), prepend `https://` before substitution. |
| `{{LINKEDIN_DISPLAY}}` | Display text only (no scheme): `linkedin.com/in/username` |
| `{{GITHUB_URL}}` | Full URL with scheme for `\href{}`: e.g. `https://github.com/username`. If `profile.yml` stores a bare host+path, prepend `https://`. |
| `{{GITHUB_DISPLAY}}` | Display text only (no scheme): `github.com/username` |
| `{{EDUCATION}}` | LaTeX `\resumeSubheading` blocks from cv.md Education section |
| `{{EXPERIENCE}}` | LaTeX `\resumeSubheading` + `\resumeItem` blocks — reordered bullets |
| `{{PROJECTS}}` | LaTeX `\resumeProjectHeading` + `\resumeItem` blocks — top 3-4 selected |
| `{{SKILLS}}` | LaTeX `\textbf{Category}{: items}` lines from cv.md Technical Skills |

## LaTeX Content Generation Rules

### Education

Each entry becomes:

```latex
    \resumeSubheading
    {Institution}{City, State}
    {Degree}{Date Range}
```

If coursework exists, add:

```latex
        \resumeItemListStart
            \resumeItem{\textbf{Coursework:} Course1, Course2, ...}
        \resumeItemListEnd
```

### Experience

Each role becomes:

```latex
    \resumeSubheading
      {Company}{Date Range}
      {Role Title}{Location}
      \resumeItemListStart
        \resumeItem{Bullet text with JD keywords injected}
        ...
      \resumeItemListEnd
```

### Projects

Each project becomes:

```latex
\resumeProjectHeading{Project Name \emph{$|$ Affiliation/Context}}{Date}
\resumeItemListStart
    \resumeItem{Bullet text}
    ...
\resumeItemListEnd
```

### Skills

```latex
    \textbf{Languages}{: C, C++, Java, ...} \\
    \textbf{Frameworks \& ML}{: PyTorch, LangChain, ...} \\
    \textbf{Tools \& Cloud}{: Docker, Kubernetes, ...}
```

## LaTeX Escaping (CRITICAL)

All text content MUST be escaped for LaTeX before insertion:

| Character | Escape |
|-----------|--------|
| `&` | `\&` |
| `%` | `\%` |
| `$` | `\$` |
| `#` | `\#` |
| `_` | `\_` |
| `{` | `\{` |
| `}` | `\}` |
| `~` | `\textasciitilde{}` |
| `^` | `\textasciicircum{}` |
| `\` | `\textbackslash{}` |
| `±` | `$\pm$` |
| `→` | `$\rightarrow$` |

**Exception:** Do NOT escape LaTeX commands themselves (`\resumeItem`, `\textbf`, etc.) — only user-supplied text content.

**Exception for URLs:** Do NOT escape text inside `\href{URL}{...}` first arguments. The URL must remain raw (or RFC 3986 percent-encoded). Only escape the *display text* (second argument). For example:
```latex
\href{https://example.com/path_with_underscores}{Example\_Display}
```

## ATS Rules (same as pdf mode)

- Single-column layout (enforced by template)
- Standard section headers: Education, Work Experience, Personal Projects, Technical Skills
- UTF-8, machine-readable via `\pdfgentounicode=1`
- Keywords distributed: first bullet of each role, skills section
- No images, no graphics, no color in body text

## Keyword Injection Strategy

Same ethical rules as `modes/pdf.md`:
- NEVER add skills the candidate doesn't have
- Only reformulate existing experience using JD vocabulary
- Examples:
  - JD says "RAG pipelines" → reword "LLM workflows with retrieval" to "RAG pipeline design"
  - JD says "MLOps" → reword "observability, evals" to "MLOps and observability"

## Overleaf Compatibility

The generated `.tex` file uses only standard CTAN packages (no custom or bundled dependencies):

- `latexsym`, `fullpage`, `titlesec`, `marvosym`, `color`, `verbatim`, `enumitem`
- `hyperref`, `fancyhdr`, `babel`, `tabularx`, `fontawesome5`, `multicol`, `glyphtounicode`

Upload the `.tex` file directly to Overleaf — compiles with no extra configuration.
