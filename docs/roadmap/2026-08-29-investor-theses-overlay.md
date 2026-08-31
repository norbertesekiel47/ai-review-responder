# Investor-theses overlay (owner-approved 2026-08-29)

Three theses came back from investor/expert conversations: (1) sell the
outcome, not the tool; (2) build for AI agents as customers; (3) target
previously-impossible industries. This doc records the verdict on each,
the market evidence behind it, and the exact roadmap changes adopted. It is
the citable answer when someone asks "why not pure outcome pricing" or "why
not agent-first now."

**Evidence base:** three `/last30days` research runs on 2026-08-29
("outcome-based pricing AI SaaS", "MCP agent-first SaaS", "AI-native
vertical software") — ~310 items across Reddit, Hacker News, TikTok,
Instagram, GitHub, YouTube, and web supplements. Supplement records:
`~/Documents/Last30Days/*-raw-v3.md` (local, not in repo). Key sources are
linked inline. Coverage caveats: X/Twitter was not searched; Reddit was
rate-limited partway in each run.

**Headline verdict: the phase order stands.** The theses change packaging,
MCP timing, positioning language, and headline metrics — not the build
sequence (connectors → recovery → ontology → truth/policy).

## 1. Thesis: "Sell the outcome" → verdict: sell outcome, charge hybrid

**What the market actually does.** Hybrid (base fee + usage/outcome layer)
is the industry standard at 41% adoption, and buyers prefer consumption
(43%) over outcome structures (27%), per
[Futurum Group](https://futurumgroup.com/press-release/are-outcome-based-and-hybrid-ai-pricing-models-rewriting-the-vendor-playbook/).
A review of 107 live pricing pages across 30+ verticals concluded "seats
didn't die, they became the floor"
([Maxio / Ben Murray](https://www.youtube.com/watch?v=oheMDXqmlqs)).
The celebrated outcome pricers are actually output pricers — Intercom
$0.99/resolved conversation, HubSpot $0.50/resolution since April 2026, per
[Userpilot](https://userpilot.com/blog/saas-pricing-models/) — and the
named killer of true outcome deals is attribution:
"attribution disputes kill deals," per
[demg.ai](https://demg.ai/blog/outcome-based-saas-pricing-ai-agents-2026/).

**RepWorth changes (adopted):**

1. **Outcome SLO packaging.** The controllable promises go into tier copy:
   every review answered within the configured SLA; every completed job
   triggers the configured ask; every critical negative escalated; every
   autonomous action policy-scoped and auditable.
2. **Autonomy telemetry.** Autonomy rate (% of reputation work completed
   with zero human intervention) and human-correction rate, computed from
   the run spine + `agent_outcomes` — no new schema. Founder dashboard now;
   customer Impact page in Phase 7.
3. **Outcome credits later, on Stripe Billing Meters**, anchored against
   the $0.50–$0.99 per-resolution market anchors — only once attribution is
   defensible (recovery outcomes, attributed reviews).
4. **Rejected: pure outcome pricing.** Attribution hazard + the standing
   FTC sentiment-incentive constraint (roadmap README). `agent_outcomes`
   stays instrumented-not-billed until then (design Decision 2).

## 2. Thesis: "Build for AI agents" → verdict: agent-READY now, agent-REVENUE later

**What the market actually does.** The infrastructure is sprinting ahead of
demand: 17,000+ public MCP servers, protocol under the Linux Foundation,
Gartner projecting 40% of enterprise apps with task-specific agents by
end-2026, per [Modall](https://modall.ca/blog/saas-trends). But a
registry-listed MCP server's own access log showed
"60 named crawlers, zero real client sessions" in 24 hours, per
[r/mcp](https://www.reddit.com/r/mcp/comments/1w06n4d/every_bot_that_crawled_my_mcp_server_in_24_hours/).
Security lags adoption: ~half of orgs experimenting, only 11% in
production, 88% reporting agent security incidents, per
[Obot](https://obot.ai/resources/learning-center/mcp-security/). And the
protocol's maintainers named **agent identity** a first-class roadmap
priority on 2026-08-22, per
[@identityjedi](https://www.tiktok.com/@identityjedi/video/7679407320169860365).
Frontier demos exist (agents buying via
[WebMCP](https://www.youtube.com/watch?v=EoNH3Tn8wYE), autonomous Lightning
payments per
[r/mcp](https://www.reddit.com/r/mcp/comments/1w1ih4v/lightning_enable_mcp_mcp_server_that_enables_ai/))
but there are no agent buyers in the SMB reputation segment yet.

**RepWorth changes (adopted):**

1. **Typed-tool (API-first) standing constraint, effective now.** Every new
   domain module (Phase 1 connectors, Phase 2 recovery verbs, Phase 3
   ontology queries) ships with a schema-validated callable interface, so
   the public surface later is a wrapper, not a project. Recorded in
   `2026-08-26-agentic-architecture.md` §1.
2. **Read-only MCP pilot pulled forward: after Phase 2** (was Phase 8).
   Five read tools, OAuth 2.1, scoped tokens per action-risk class, MCP
   actor attribution on the run spine (extends the Channel-actor pattern),
   listed in MCP registries as a free distribution probe. **Design center:
   the agent-identity gap** — the ecosystem's declared unsolved problem is
   precisely what the Judge, action-risk classes, and per-account policy
   grants already answer.
3. **AEO probe.** Periodic cost-bounded checks of how a business appears in
   AI-assistant answers for its category + location, stored
   competitor-snapshot-style. Consumer agents already mediate discovery.
4. **Rejected for now:** write-capable MCP tools (88%-incident security
   climate; read-first is both safer and a selling point), agentic-payment
   work, and any agent-framework adoption (standing refusal, architecture
   doc §5).

## 3. Thesis: "Rebuild impossible industries" → verdict: rebuild the JOB, keep the wedge

**What the market actually does.** Vertical AI is a real capital wave —
$3.07B across 73 disclosed deals in the trailing year — but 72.6% of the
capital concentrates in Legal, Insurance, Construction, and Healthcare, per
[Euclid Ventures](https://insights.euclid.vc/p/the-vertical-report-2026-full-version);
local-business reputation is comparatively open ground. The founder
community is actively stress-testing the category
("[AI-native service companies, real or gimmick?](https://www.reddit.com/r/ycombinator/comments/1vygizd/ainative_service_companies_real_or_gimmick/)",
r/ycombinator, 44 comments). "AI employee" is already SMB shelf language —
Vendasta markets MARiO as "a fully autonomous AI employee," RingCentral
sells an AI Receptionist, per
[Vendasta](https://www.vendasta.com/blog/ai-native-saas/). SMB adoption is
real: over half of SMBs use AI, most daily; 58% report saving 20+
hours/month, per
[Thryv](https://www.businesswire.com/news/home/20251216113386/en/Thryv-Experts-Share-Top-AI-Trends-That-Will-Drive-Small-Business-Succes).
The "SaaS is dead" panic already peaked and corrected, per
[Long Angle](https://www.longangle.com/alts-education/software-ai).

**RepWorth changes (adopted):**

1. **The impossible product, not an impossible industry.** The endgame
   narrative is the front-office employee no 5-person business could ever
   afford: reputation manager + recovery desk + solicitation, governed. The
   wedge (reputation) and phases are unchanged — they ARE the rebuild when
   sold as headcount replacement.
2. **Category-language rule.** Use "AI employee" to name the category (it
   primes buyers) but never lead with it alone — competitors print it.
   Lead with the governed part; it is the only claim they cannot copy.
   Recorded in the positioning doc §3 and brand story §5.
3. **Proof metrics in the market's own language:** hours saved per month
   (the 20+ hours Thryv benchmark) next to autonomy rate. The
   r/ycombinator "real or gimmick" debate defines the proof burden:
   retention plus a measured number, not a demo.

## 4. Change log (what this overlay edited)

| File | Change |
|---|---|
| `README.md` | Locked decision 5 (this overlay); pricing open-decision gains the recommended hybrid shape |
| `2026-08-26-forward-roadmap.md` | Cross-cutting: outcome SLO packaging + autonomy telemetry; MCP pilot pull-forward; AEO probe; pricing recommendation. Phase 8 keeps only the write surface |
| `2026-08-26-agentic-architecture.md` | §1 typed-tool standing constraint; §3/§4 MCP pilot timing + agent-identity design center |
| `2026-08-26-positioning-governed-autonomy.md` | §3 category-language check ("AI employee" is shelf language) + proof metrics |
| `2026-08-26-brand-story.md` | §5 voice rule: category words name, governance proves |
