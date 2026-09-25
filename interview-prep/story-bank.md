# Story Bank — Master STAR+R Stories

This file accumulates your best interview stories over time. Each evaluation (Block F) adds new stories here. Instead of memorizing 100 answers, maintain 5-10 deep stories that you can bend to answer almost any behavioral question.

## How it works

1. Every time `/career-ops oferta` generates Block F (Interview Plan), new STAR+R stories get appended here
2. Before your next interview, review this file — your stories are already organized by theme
3. The "Big Three" questions can be answered with stories from this bank:
   - "Tell me about yourself" → combine 2-3 stories into a narrative
   - "Tell me about your most impactful project" → pick your highest-impact story
   - "Tell me about a conflict you resolved" → find a story with a Reflection

## Stories

<!-- Stories will be added here as you evaluate offers -->
<!-- Format:
### [Theme] Story Title
**Source:** Report #NNN — Company — Role
**S (Situation):** ...
**T (Task):** ...
**A (Action):** ...
**R (Result):** ...
**Reflection:** What I learned / what I'd do differently
**Best for questions about:** [list of question types this story answers]
-->

### [Distributed Systems] Tesla Go Orchestration API for Kubeflow
**Source:** Report #1741 — Figma — Software Engineer - Application Platform (evaluation; not applied)
**S (Situation):** Kubeflow pipeline ran ad-hoc with no feedback loop; engineers had no way to trigger, monitor, or retrieve results from correlation analysis without manual intervention.
**T (Task):** Build a Go API layer to expose pipeline execution, status, and human-readable report publishing to Amazon S3 — enabling self-serve analysis for manufacturing engineers.
**A (Action):** Designed REST endpoints in Go, integrated S3 report publishing, built async status feedback loop over Kubeflow's execution API.
**R (Result):** Engineers gained self-serve analysis capability; eliminated manual pipeline runs and the bottleneck on the data team.
**Reflection:** Would have added OpenTelemetry tracing from day one — debugging the async job state across Kubeflow and S3 was the hardest part; visibility was retrofitted and cost time.
**Best for questions about:** Distributed systems, API design, async architecture, self-serve tooling, cross-team impact

### [Reliability & Observability] AWS CloudWatch Integration
**Source:** Report #1741 — Figma — Software Engineer - Application Platform (evaluation; not applied)
**S (Situation):** AWS registration system and ingestion pipeline had zero observability; issues were caught reactively by customer tickets.
**T (Task):** Add proactive monitoring before production issues surfaced at customer impact level.
**A (Action):** Built CloudWatch dashboards and alarms across both services, tuned alarm thresholds after initial false-positive round.
**R (Result):** 10% reduction in customer tickets; on-call response time improved; team could detect regressions before users noticed.
**Reflection:** Learned to set alarm thresholds conservatively first and tune down — false positives early are cheaper than missed alerts; started with p90 then moved to p95 after baselining.
**Best for questions about:** Observability, reliability engineering, production monitoring, proactive vs reactive operations

### [CI/CD & Test Infrastructure] Nokia GitLab CI/CD + Kubernetes Parallel Tests
**Source:** Report #1741 — Figma — Software Engineer - Application Platform (evaluation; not applied)
**S (Situation):** Test suite ran sequentially; regression runs blocked development cycles and slowed the team's ability to merge confidently.
**T (Task):** Integrate CI with containerized Pytest on a Kubernetes cluster to enable parallel test execution and dynamic scaling.
**A (Action):** Configured dynamic pod scaling, 25+ parallel runners, automated reporting pipeline; hit race conditions in shared test fixtures and added fixture isolation.
**R (Result):** Significantly faster regression cycle; team could merge more frequently and with higher confidence.
**Reflection:** Dynamic scaling introduced race conditions in shared test fixtures I hadn't anticipated — added fixture isolation as a standard practice thereafter; shared mutable state is the enemy of parallelism.
**Best for questions about:** CI/CD, test infrastructure, developer experience, Kubernetes, parallel systems

### [Performance Optimization] Qualcomm C# + C++ Native Driver Integration
**Source:** Report #1741 — Figma — Software Engineer - Application Platform (evaluation; not applied)
**S (Situation):** Color calibration tool needed low-latency native driver access from a managed C# layer; initial architecture had the two layers tightly coupled with no clean interface.
**T (Task):** Design and implement a clean interface between ASP.NET C# backend and native C++ drivers.
**A (Action):** Defined P/Invoke boundary layer, abstracted driver calls behind a service interface, enabling independent upgrades to either layer.
**R (Result):** 50% reduction in processing latency; clean boundary made subsequent driver upgrades routine without touching the managed layer.
**Reflection:** The P/Invoke boundary should have been defined as an interface from day one; retrofitting it after the initial integration was working added a full sprint of risk. Define boundaries before implementation, not after.
**Best for questions about:** Performance optimization, system architecture, cross-language integration, technical trade-offs

### [AI / Production Systems] Tesla LLM Log Pipeline
**Source:** Report #1740 — Gusto — Software Engineer, AI Developer Tools
**S (Situation):** Tesla's manufacturing systems generated ~1M log lines per day; engineers were triaging anomalies manually, creating a significant bottleneck.
**T (Task):** Build an LLM-driven log-summarization pipeline that could process the full log volume and surface anomalies automatically.
**A (Action):** Designed and shipped a Python pipeline using OpenAI and Apache Airflow to ingest, chunk, and summarize log batches; added anomaly flagging logic to surface high-priority issues first.
**R (Result):** Reduced manual triage time by 20%; pipeline ran reliably in production processing ~1M lines/day.
**Reflection:** Would add an evaluation framework alongside the pipeline to measure summarization quality on a random holdout sample — right now correctness is measured implicitly by downstream triage outcomes, not directly.
**Best for questions about:** production AI systems, LLM pipelines, scaling ML to production, handling large data volumes, impact-driven engineering

### [Observability / Reliability] AWS CloudWatch Integration
**Source:** Report #1740 — Gusto — Software Engineer, AI Developer Tools
**S (Situation):** Two new services (partner registration + Salesforce article ingestion pipeline) were going live with no observability layer; incidents would be invisible until customers reported them.
**T (Task):** Instrument both services with monitoring before launch.
**A (Action):** Integrated CloudWatch dashboards and alarms across both services; set latency, error rate, and queue-depth thresholds aligned to expected SLAs.
**R (Result):** Enabled proactive issue detection; reduced customer support tickets by 10%.
**Reflection:** Would instrument earlier in the development cycle rather than as a launch gate — observability surfaces integration bugs during development, not just post-launch.
**Best for questions about:** reliability engineering, observability, production readiness, SRE mindset, customer impact

### [Frontend / Full-Stack] AWS Partner Portal — TypeScript/React/Next.js
**Source:** Report #1808 — Affirm — Software Engineer II, Fullstack (App Experience)
**S (Situation):** AWS Partner users had no self-serve interface for account registration; onboarding required manual back-and-forth.
**T (Task):** Build a frontend portal giving partners a streamlined interface to manage onboarding and account access, backed by the new registration APIs.
**A (Action):** Built the portal in TypeScript, React, and Next.js, wired it to the Java/Spring Boot/DynamoDB registration APIs also built during the internship.
**R (Result):** Partners gained a self-serve onboarding interface, streamlining what had been a manual process.
**Reflection:** Would add component-level tests earlier in the build — UI regressions surfaced later than they should have, closer to internship end than to first integration.
**Best for questions about:** Frontend development, full-stack ownership (API + UI in one project), partner/developer-facing product design, React/Next.js

### [CI/CD / Developer Experience] Nokia Parallel Test Infrastructure
**Source:** Report #1740 — Gusto — Software Engineer, AI Developer Tools
**S (Situation):** Nokia's regression cycle required 25+ test runs that ran sequentially, making the feedback loop slow and blocking developer productivity.
**T (Task):** Enable parallel test execution to speed up regression coverage.
**A (Action):** Integrated GitLab CI/CD with containerized Pytest suites on a Kubernetes cluster; configured dynamic node scaling to match workload.
**R (Result):** 25+ parallel test runs enabled; regression cycle time cut significantly; dynamic scaling prevented over-provisioning.
**Reflection:** Would add per-test trend dashboards so developers could self-serve on flaky test patterns rather than waiting for a full CI report.
**Best for questions about:** developer experience, CI/CD, internal tooling, platform engineering, test infrastructure

### [Systems / Reliability] Cisco Real-Time Memory Leak Detector (C)
**Source:** Report #1820 — TransMarket Group — Junior Software Engineer
**S (Situation):** Uncontrolled memory leaks and runaway high-CPU processes were degrading system stability with no automated response.
**T (Task):** Build a real-time monitoring system in C that could detect and remediate these conditions without manual intervention.
**A (Action):** Implemented a C-based process monitor that automatically detects memory leaks and high-CPU processes and terminates them.
**R (Result):** Reduced overall memory usage by 20%; improved system stability.
**Reflection:** Would add historical trend logging alongside the detector — catching a leak's *slope* earlier would have caught some cases before they crossed the termination threshold.
**Best for questions about:** systems programming, reliability, production stability, low-level debugging, automation

### [Machine Learning / Security] Nokia Encrypted Traffic Anomaly Classifier
**Source:** Report #1821 — Voleon Group — Software Engineer, Strategy Research Analytics
**S (Situation):** Detecting anomalies in encrypted network traffic relied on manual inspection, which was slow and didn't scale.
**T (Task):** Apply machine learning to classify packet patterns and flag anomalies in encrypted flows automatically.
**A (Action):** Built classifiers in Python using scikit-learn and NumPy to detect anomalous packet patterns from traffic metadata.
**R (Result):** Improved validation efficiency and reduced reliance on manual inspection.
**Reflection:** Reflected on precision/recall tradeoffs for a security-sensitive classifier — false negatives are far costlier than false positives here, which should drive threshold selection, not accuracy alone.
**Best for questions about:** machine learning in production, security/anomaly detection, statistical tradeoffs, scikit-learn

### [Backend / Partner Systems] AWS Partner Registration API (Java/Spring Boot/DynamoDB)
**Source:** Report #1822 — Voleon Group — Software Engineer, Data Infrastructure
**S (Situation):** AWS Partner users had no structured registration path; onboarding was manual and didn't scale.
**T (Task):** Build a backend registration system that could onboard partners programmatically at scale.
**A (Action):** Designed and implemented RESTful APIs in Java/Spring Boot, backed by EC2 and DynamoDB, exposing the registration workflow as a service.
**R (Result):** Enabled seamless partner onboarding at scale (later paired with a self-serve frontend portal — see the TypeScript/React/Next.js story above).
**Reflection:** Would formalize API versioning from the start — an early schema change broke a downstream consumer that had assumed the initial shape was stable.
**Best for questions about:** backend API design, distributed data stores (DynamoDB), scaling partner/developer-facing systems, service ownership

### [Developer Tooling / Observability] Cisco Build-Health Dashboard (Java/Grafana/Kafka)
**Source:** Report #1822 — Voleon Group — Software Engineer, Data Infrastructure
**S (Situation):** Development teams had no visibility into daily build health, so breaking commits were caught late, slowing debugging.
**T (Task):** Extend performance visibility into the developer workflow itself, not just runtime systems.
**A (Action):** Built an automated dashboard in Java, streaming through Kafka into Grafana, tracking daily build changes.
**R (Result):** Accelerated detection of breaking commits and reduced debugging time for development teams.
**Reflection:** Would have added Slack alerting sooner — teams discovered the dashboard late in their workflow because it required them to go looking for it rather than surfacing proactively.
**Best for questions about:** developer tooling, observability, streaming data (Kafka), internal platform engineering
