# Mode: contacto -- LinkedIn Power Move

## Input Modes

`contacto` runs in one of two modes, decided by the argument:

- **Single (default):** a JD, URL, company+role, or a single report number → find contacts for that one role and draft a message. Run the single-target workflow below.
- **Batch (selector):** a selector that resolves to a *set* of roles → run the single-target workflow for each, in parallel, then emit one consolidated table.

### Batch selectors

| Selector | Resolves to |
|----------|-------------|
| `top5` / `topN` | The N highest-scoring rows in `data/applications.md` with status `Evaluated`. Sort by score descending, take the first N. |
| `>=4.0` (or `>=3.5`, etc.) | Every `Evaluated` row with score ≥ the threshold. |
| `156 158 161` | Those specific report numbers (the `#` column), any status. |

**Resolution rules:**
1. Read `data/applications.md`. Parse the table columns: `# | Date | Company | Role | Score | Status | PDF | Report | Notes`. Score is formatted `X.X/5` — parse the numeric part.
2. For `topN` and `>=X` selectors, restrict to status `Evaluated` (a role already `Applied`/`Interview`/`Rejected`/`SKIP` doesn't need cold outreach). Explicit report numbers bypass the status filter.
3. For each resolved row, the company + role + report file (`reports/{num}-...md`) provide the JD context the single-target workflow needs. Read the report for the hook/proof material.
4. If a selector resolves to **0 rows**, tell the user (e.g. "no `Evaluated` roles ≥ 4.0") and stop. If it resolves to **1 row**, just run single mode.

### Batch execution

1. Resolve the selector to the target set (cap at 10 — if more match, take the top 10 by score and note the rest were skipped).
2. **If the Agent tool is available** and there are 3+ targets, fan out: one background agent per role running the single-target workflow. Otherwise process sequentially.
3. Collect each role's primary target + drafted message into a **consolidated table**, sorted by score descending:

```
| # | Company | Role | Score | Primary contact | Title | Drafted message |
|---|---------|------|-------|-----------------|-------|-----------------|
| 932 | Etched | Core SWE | 3.8/5 | Jane Doe | Eng Manager, Core | "..." |
```

4. Where a role's contact could not be found with confidence, show `— (not found)` in the contact column and still list the best alternate from step 6 of the single workflow.
5. Do **not** send anything. Output is for the user to review and send manually (LinkedIn connection requests are sent by the user).

---

## Single-target workflow

1. **Identify targets** via WebSearch:
   - Hiring manager of the team
   - Assigned recruiter
   - 2-3 team peers (people with similar roles)
   - Interviewer (if the candidate already has a scheduled interview)

2. **Classify contact type** -- ask the candidate or infer from context:
   - **Recruiter** -- person whose role is talent acquisition, sourcing, or recruiting
   - **Hiring Manager** -- the person who leads the hiring team
   - **Peer** -- someone with a similar role in the team (indirect referral)
   - **Interviewer** -- someone who will interview the candidate (known date)

3. **Select primary target**: the person who would benefit most from the candidate being there

4. **Generate message** with a 3-sentence framework adapted to the contact type:

   ### Recruiter
   - **Sentence 1 (Fit)**: Direct match criteria -- role, relevant experience, availability, or location
   - **Sentence 2 (Proof)**: Data that answers their screening questions before they ask them (e.g., "5 years building ML pipelines, currently in Berlin, available immediately")
   - **Sentence 3 (CTA)**: "Happy to share my CV if this aligns with what you're looking for"

   ### Hiring Manager
   - **Sentence 1 (Hook)**: Specific challenge their team is facing (extracted from the JD, company blog, or news)
   - **Sentence 2 (Proof)**: Candidate's greatest quantifiable achievement showing they have solved similar problems
   - **Sentence 3 (CTA)**: "Would love to hear how your team is approaching [specific challenge]"

   ### Peer (referral)
   - **Sentence 1 (Interest)**: Genuine reference to their work -- blog post, talk, open-source project, or publication
   - **Sentence 2 (Connection)**: Something the candidate is doing in the same space (NOT a job pitch)
   - **Sentence 3 (CTA)**: "I've been working on similar problems at [company], would love to hear your take on [topic]"
   - **Note**: DO NOT ask for a job. The referral happens naturally if the conversation flows.

   ### Interviewer (pre-interview)
   - **Sentence 1 (Research)**: Reference to something specific from their work or trajectory
   - **Sentence 2 (Context)**: Light connection to the candidate's experience in that area
   - **Sentence 3 (CTA)**: "Looking forward to our conversation on [date]"
   - **Note**: Light tone, not desperate. The goal is to show that you prepared.

5. **Versions**:
   - EN (default)
   - ES (if Spanish company)

6. **Alternative targets** with justification for why they are good second choices

**Message rules:**
- Maximum 300 characters (LinkedIn connection request limit)
- NO corporate-speak
- NO "I'm passionate about..."
- Something that makes them want to respond
- NEVER share phone number
- The contact type changes the EMPHASIS, not the structure
