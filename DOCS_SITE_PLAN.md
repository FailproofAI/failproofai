# Fresh FailproofAI documentation site plan

## 1. Goal

Create a new Mintlify site for teams deploying agents where failures are costly. The site should help a new reader understand and complete one reliability loop:

1. Capture agent runs.
2. Trace what the agent did.
3. Audit runs to find failures.
4. Evaluate quality continuously.
5. Convert recurring failures into policies.
6. Deploy policies to prevent the failure from happening again.

The core promise is concrete: **find agent failures with audits, then prevent them with deployed policies**. Deep tracing and online evaluations provide the evidence needed to do both safely.

## 2. Audience and reader outcomes

### Primary audience

- Engineers putting agents into production
- Platform and reliability teams responsible for agent fleets
- Security and governance teams controlling agent actions
- Engineering leaders accountable for failures, cost, and compliance

### What readers must be able to do

Within ten minutes, a reader should be able to:

- Understand the path from an agent run to a prevented failure
- Choose the right installation and instrumentation path
- Send a first trace and find it in FailproofAI
- Run a failure audit and inspect a finding
- Add an online evaluation to a live workflow
- Start a policy in observe mode, verify its effect, and enforce it
- Find exact CLI, SDK, collector, and HTTP API details without searching the repository

## 3. Product story

Use one consistent model across the site:

```text
Agent runs
   ↓
Deep traces ──→ Online evaluations
   ↓                    ↓
Failure audits ──→ Findings and issues
   ↓
Policies in observe mode
   ↓
Enforced policies
   ↓
Safer future runs
```

### Vocabulary

| Term | Plain-language definition |
|---|---|
| Run | One execution of an agent task |
| Event | A recorded action within a run, such as a model call or tool use |
| Trace | The ordered, nested view of everything that happened in a run |
| Evaluation | A score or judgment applied to a live or completed run |
| Audit | A systematic review that searches runs for failure patterns |
| Finding | A specific failure or risk discovered by an audit |
| Issue | The workflow used to investigate, assign, and resolve a finding |
| Policy | A rule that observes, blocks, or redirects risky agent behavior |
| Enforcement | Deploying a policy so it affects live agent actions |

Avoid introducing internal component names before these user-facing concepts.

## 4. Information architecture

Use Mintlify tabs as the root navigation. This separates learning, implementation, operations, and reference while keeping the main workflow shallow.

### Tab: Start

1. **What is FailproofAI?**
   - The failure-to-prevention loop
   - When to use audits, evaluations, tracing, and policies
   - A two-minute product tour
2. **Quickstart: find and prevent one failure**
   - Install
   - Capture a run
   - Inspect the trace
   - Run an audit
   - Review a finding
   - Deploy a policy in observe mode
   - Switch to enforce mode
3. **Choose your setup**
   - Local/open-source only
   - FailproofAI Cloud
   - Enterprise/on-premises
4. **Core concepts**
5. **Pricing and usage**

### Tab: Observe

1. **Overview**
2. **Capture agent runs**
   - Python SDK
   - Collector
   - Codex
   - Claude Code
   - OpenClaw
   - Hermes
   - Custom event ingestion
3. **Read a trace**
   - Sessions and events
   - Nested agent and tool activity
   - Model calls, latency, errors, and human input
4. **Query and dashboards**
5. **Errors and alerts**
6. **Data handling and privacy**

### Tab: Find failures

1. **Failure audits overview**
2. **Run your first audit**
3. **Write an audit goal**
4. **Scope runs and provide reference context**
5. **Understand findings**
6. **Triage findings as issues**
7. **Schedule recurring audits**
8. **Audit recipes**
   - Incorrect tool use
   - Repeated retry loops
   - Unsafe data access
   - Task abandonment
   - Excessive cost or latency
   - Human escalation failures

### Tab: Evaluate

1. **Online evaluations overview**
2. **Create your first evaluator**
3. **Synchronous evaluations**
4. **Asynchronous evaluations**
5. **Evaluation suites**
6. **Scores, labels, and trends**
7. **Use evaluations in dashboards and alerts**
8. **Evaluation recipes**
   - Task success
   - Policy compliance
   - Tool selection
   - Hallucination and groundedness
   - Cost and latency budgets

### Tab: Prevent failures

1. **Policies overview**
2. **Builtin policies**
3. **Write a custom policy**
4. **Test a policy locally**
5. **Observe before enforcing**
6. **Deploy from FailproofAI Cloud**
7. **Machines and policy targeting**
8. **Roll out safely**
9. **Roll back a deployment**
10. **Policy integrity and failure behavior**
11. **Policy recipes**
    - Block destructive commands
    - Restrict sensitive file access
    - Require approval for risky tools
    - Stop runaway loops
    - Redirect an agent after a known failure

### Tab: Reference

#### Group: Operate

1. **Production checklist**
2. **Organizations, users, and RBAC**
3. **API keys and permission sets**
4. **Environments and multi-tenant logging**
5. **Retention and backfill**
6. **Usage and limits**
7. **Security**
8. **SSO/SAML**
9. **On-premises deployment**
10. **Troubleshooting**

#### Group: Technical reference

1. **CLI reference**
2. **Python tracing SDK**
3. **Evaluator SDK**
4. **Collector configuration**
5. **Event schema**
6. **Environment variables**
7. **HTTP API**
   - Authentication and health
   - Events
   - Sessions
   - Evaluations and evaluation suites
   - Audits and findings
   - Issues
   - Alerts
   - Queries and dashboards
   - Policies and enforcement
   - API keys, users, and permissions
   - Usage and settings
   - Assistant
8. **Changelog**

Keep Pricing, Status, GitHub, and Support as global anchors. The Pricing anchor should point to the internal `/start/pricing-and-usage` page, which links to `https://befailproof.ai/pricing/` as the canonical source for current prices and purchase decisions.

## 5. First-release page set

Ship a focused first release before documenting every endpoint.

### P0: required for launch

- What is FailproofAI?
- Quickstart: find and prevent one failure
- Choose your setup
- Core concepts
- Pricing and usage
- Capture agent runs overview
- Python SDK quickstart
- Collector quickstart
- Read a trace
- Failure audits overview
- Run your first audit
- Understand findings
- Online evaluations overview
- Create your first evaluator
- Policies overview
- Write a custom policy
- Observe before enforcing
- Deploy from FailproofAI Cloud
- Production checklist
- API keys and permissions
- Security
- CLI reference landing page
- Python SDK reference landing page
- Evaluator SDK reference landing page
- HTTP API landing page and authentication

### P1: completes common production workflows

- Harness-specific capture guides
- Queries, dashboards, errors, and alerts
- Audit and evaluation recipes
- Evaluation suites
- Issues workflow
- Policy targeting, rollout, and rollback
- Organizations, RBAC, environments, retention, and usage
- Complete HTTP API reference

### P2: enterprise and depth

- SSO/SAML
- Multi-tenant governance
- On-premises deployment
- Compliance reporting
- Advanced query recipes
- Assistant and automation workflows
- Full troubleshooting matrix

## 6. Page design rules

Every conceptual or workflow page should answer, in this order:

1. What problem does this solve?
2. When should you use it?
3. What happens under the hood?
4. How do you complete the smallest useful workflow?
5. How do you verify that it worked?
6. What can go wrong?
7. What should you do next?

### Standard workflow page template

```mdx
---
title: "Run your first failure audit"
description: "Review production agent runs and turn a recurring failure into an actionable finding."
---

One short paragraph describing the outcome.

<Info>Prerequisites and required permissions.</Info>

## Before you begin

## Run the audit

<Steps>
  ...
</Steps>

## Verify the result

<Check>Describe exactly what the reader should see.</Check>

## Troubleshooting

## Next step
```

Use `Steps` for procedures, `Tabs` only for mutually exclusive choices, `CodeGroup` for language variants, and `Accordion` for optional detail. Keep critical safety behavior visible rather than hidden in accordions.

## 7. Quickstart specification

The quickstart should be a complete reliability story, not an installation-only page.

### Scenario

Use a small support agent that calls a refund tool. The observed failure is an attempted refund above an approved limit.

### Reader journey

1. Install FailproofAI and authenticate.
2. Instrument or capture the sample agent.
3. Run the agent once with a risky request.
4. Open the trace and identify the tool call.
5. Run an audit that asks whether refund controls were followed.
6. Inspect the resulting finding.
7. Create or select a policy limiting refund behavior.
8. Deploy it in observe mode.
9. Replay the scenario and verify the would-block result.
10. Switch to enforce mode.
11. Replay again and verify that the risky action is stopped and the agent receives corrective guidance.

This page should link to deeper pages at each step without requiring them to finish the quickstart.

## 8. API and reference strategy

### HTTP API

Generate and maintain an OpenAPI specification from the server routes and request/response types. Use Mintlify's OpenAPI navigation support for exhaustive endpoint reference. Add hand-written workflow pages for multi-step operations such as:

- Authentication and organization selection
- Creating and running an audit
- Fetching findings and changing their status
- Creating an evaluation and reading scores
- Publishing and deploying a policy
- Creating least-privilege API keys

Do not make hand-written endpoint pages the source of truth when types and routes can generate the specification.

### SDKs and CLI

- Generate command reference from the CLI's actual command tree and `--help` output.
- Generate Python API reference from public classes, methods, decorators, and models.
- Keep task-oriented guides separate from generated reference.
- Add a source link and package version to every generated reference section.

### Reference freshness

Add CI checks that fail when:

- A public server route is absent from OpenAPI
- CLI help output differs from committed reference
- Public SDK symbols differ from generated reference
- An internal documentation link is broken
- `mint validate` or `mint a11y` fails

## 9. Pricing page content

The documentation should explain limits that affect implementation, then link to the canonical pricing page for purchase decisions.

| Plan | Included usage relevant to docs |
|---|---|
| Free Forever + Open Source | 5,000 runs/month, 100 evals/month, 3 failure audits/month, deep tracing, builtin dashboards, 30-day retention, 7-day backfill, unlimited local policy enforcement |
| Team — $99/month | 50,000 runs/month, 2,000 evals/month, unlimited audits up to 1/day, 90-day backfill, 5 users, CLI, MCP, agent, custom queries |
| Scale — $599/month | 500,000 runs/month, 20,000 evals/month, unlimited audits up to 4/day, 90-day retention, unlimited backfill/users/agents, auto policy authoring, multi-tenant logging, RBAC and SSO/SAML |
| Enterprise — custom | Custom usage and retention, multi-tenant policy enforcement, governance, on-premises deployment, compliance reporting, and FDE support |

Add a visible `Last verified` date and treat the pricing website as authoritative. Avoid copying overage prices into multiple guide pages.

## 10. Content style

- Write for an engineer who is worried about a real production failure.
- Lead with the outcome, not the feature name.
- Use second person and active voice.
- Prefer one realistic example carried across tracing, audits, evaluations, and policies.
- Define a term before using it.
- Show expected output after every command or procedure.
- State permissions, data exposure, and enforcement effects before a risky step.
- Distinguish **observe**, **would block**, and **enforce** consistently.
- Avoid unsupported reliability claims and generic adjectives.
- Use “policy” for preventive controls and “evaluation” for measurement; do not blur them into “guardrails.”

## 11. Visuals

Create only visuals that reduce conceptual load:

- The reliability loop on the introduction page
- An annotated trace showing model, tool, policy, and human events
- Audit → finding → issue lifecycle
- Evaluation flow for synchronous and asynchronous execution
- Policy rollout sequence: draft → observe → verify → enforce → roll back
- Cloud architecture and data-boundary diagram

Prefer product screenshots for UI procedures and small diagrams for systems concepts. Every image needs descriptive alt text and a documented refresh owner.

## 12. Site implementation

Build the new site in a clean directory so no legacy page or navigation choice is inherited accidentally.

```text
docs-next/
├── docs.json
├── index.mdx
├── quickstart/
├── observe/
├── audits/
├── evaluations/
├── policies/
├── operate/
├── reference/
├── api/
├── images/
├── snippets/
├── openapi.yaml
└── custom.css
```

Use a root-level tab structure in `docs.json`, groups within each tab, and global anchors for Pricing, Status, GitHub, and Support. Keep the initial hierarchy to at most two sidebar levels.

## 13. Delivery phases

### Phase 1: source inventory and contracts

- Confirm public product names and terminology
- Inventory public CLI commands, SDK surfaces, event types, and HTTP routes
- Generate an initial OpenAPI document
- Mark internal-only, enterprise-only, deprecated, and unstable features
- Assign an engineering owner to each reference source

### Phase 2: foundation

- Create `docs-next/docs.json`
- Configure brand, search, analytics, global anchors, redirects, and SEO
- Create reusable page templates and snippets
- Add validation, accessibility, and link checks to CI

### Phase 3: core journey

- Write the introduction, concepts, and full-loop quickstart
- Write the P0 tracing, audit, evaluation, and policy guides
- Produce the five core diagrams
- Test every command and example against a clean environment

### Phase 4: reference

- Publish OpenAPI-generated HTTP reference
- Generate CLI and Python reference
- Add authentication, permissions, rate/usage limits, errors, and pagination conventions

### Phase 5: production operations

- Add security, RBAC, retention, deployment, rollback, and troubleshooting content
- Add P1 recipes and harness-specific capture guides
- Review with reliability, security, and first-time-user perspectives

### Phase 6: cutover

- Run `mint validate`, `mint broken-links`, and `mint a11y`
- Verify all P0 workflows from a clean machine
- Add redirects for externally linked URLs that must be retained
- Point the docs domain to the new site
- Monitor failed searches, 404s, quickstart completion, and support questions

## 14. Acceptance criteria

The fresh site is ready to launch when:

- A new user can complete the failure-to-prevention quickstart without private knowledge.
- The introduction explains audits, policies, tracing, and evaluations on one screen.
- Every P0 procedure states prerequisites and a verifiable success condition.
- All published commands and code examples have been executed successfully.
- Public HTTP endpoints are represented in OpenAPI or explicitly marked internal.
- Pricing and plan-dependent features match the canonical pricing page.
- Search returns the intended page for “trace,” “audit,” “finding,” “evaluation,” “policy,” “enforce,” “API key,” and “retention.”
- Navigation has no more than six primary tabs and two sidebar levels.
- Broken-link, accessibility, and Mintlify validation checks pass.
- Security and data-handling claims have an owner and review date.

## 15. Decisions to confirm before writing

- Whether the public product name should always be “FailproofAI” or use a spaced form in prose
- Which agent frameworks and harnesses are officially supported at launch
- Whether policy authoring is available on all plans or only specific cloud plans
- Exact cloud API base URLs and versioning policy
- Which HTTP endpoints are public, partner-only, enterprise-only, or internal
- Current data residency, encryption, compliance, and FDE claims
- Whether the Free audit limit means three runs per calendar month and how scheduling interacts with plan limits
- Whether “run” and “session” are user-facing synonyms or distinct billable concepts
- The supported rollout targets and behavior when cloud policy delivery is unavailable
