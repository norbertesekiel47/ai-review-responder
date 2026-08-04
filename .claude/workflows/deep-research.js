export const meta = {
  name: 'deep-research',
  description: 'Fan-out research with diverse-lens verification, Context7 routing, and an implementation-ready intake seed',
  whenToUse: 'Deep, multi-source, fact-checked research. Implementation-shaped questions additionally get a /feature intake seed; pass {question, spike: true} to also build a runnable proof.',
  phases: [
    { title: 'Scope', detail: 'decompose question into angles, detect library topics' },
    { title: 'Search', detail: 'one agent per angle — web + Context7 routing' },
    { title: 'Fetch', detail: 'dedup URLs, fetch sources, extract falsifiable claims' },
    { title: 'Verify', detail: 'per-claim diverse lenses: fidelity, recency, source-class' },
    { title: 'Completeness', detail: 'critic names missed modalities; at most one extra round' },
    { title: 'Synthesize', detail: 'merge dupes, rank by confidence, cite, emit intake seed' },
  ],
}

const question = typeof args === 'string' ? args : args?.question
if (!question || !question.trim()) throw new Error('deep-research needs a question: pass args as a string or {question: "..."}')
const wantSpike = typeof args === 'object' && args?.spike === true

// Budget-scaled fan-out: default 5 angles / 15 sources; a "+400k"-style budget widens both.
const ANGLES = budget.total ? Math.min(8, Math.max(3, Math.floor(budget.total / 80_000))) : 5
const SOURCE_CAP = budget.total ? Math.min(30, Math.max(10, Math.floor(budget.total / 40_000))) : 15

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['angles', 'implementation_shaped'],
  properties: {
    angles: {
      type: 'array', minItems: 2, maxItems: 8,
      items: {
        type: 'object', required: ['query', 'kind'],
        properties: {
          query: { type: 'string' },
          kind: { enum: ['web', 'library', 'recency'] },
          rationale: { type: 'string' },
        },
      },
    },
    libraries: { type: 'array', items: { type: 'string' } },
    implementation_shaped: { type: 'boolean' },
  },
}

const SEARCH_SCHEMA = {
  type: 'object', required: ['results'],
  properties: {
    results: {
      type: 'array', maxItems: 10,
      items: {
        type: 'object', required: ['url', 'title'],
        properties: { url: { type: 'string' }, title: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
}

const CLAIMS_SCHEMA = {
  type: 'object', required: ['claims'],
  properties: {
    claims: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', required: ['text', 'quote', 'url', 'source_class'],
        properties: {
          text: { type: 'string', description: 'one falsifiable claim' },
          quote: { type: 'string', description: 'verbatim supporting excerpt from the source' },
          url: { type: 'string' },
          source_class: { enum: ['official_docs', 'changelog_or_release', 'maintainer', 'reputable_publication', 'community', 'blog', 'seo_content'] },
          version_context: { type: 'string', description: 'library/API version the claim is about, if any' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', required: ['refuted'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

const CRITIC_SCHEMA = {
  type: 'object', required: ['sufficient', 'missing'],
  properties: {
    sufficient: { type: 'boolean' },
    missing: {
      type: 'array', maxItems: 3,
      items: { type: 'object', required: ['query', 'kind'], properties: { query: { type: 'string' }, kind: { enum: ['web', 'library', 'recency'] } } },
    },
  },
}

// ---- Scope ----
phase('Scope')
const scope = await agent(
  `Decompose this research question into ${ANGLES} search angles: "${question}"\n` +
  `Rules: angles must be mutually distinct (different modality or sub-question, not rephrasings). ` +
  `If the question involves a specific library/framework/API, mark those angles kind:"library" and list the library names. ` +
  `ALWAYS include exactly one kind:"recency" angle ("what changed recently / current stable version / deprecations") — for implementation questions, stale-docs answers are the #1 failure mode. ` +
  `Set implementation_shaped:true if the asker's goal is to BUILD something from the findings (how-to, integration, migration, architecture choice) rather than purely to know something.`,
  { label: 'scope', schema: SCOPE_SCHEMA },
)
if (!scope) throw new Error('scope agent failed')
log(`${scope.angles.length} angles (${scope.angles.filter(a => a.kind === 'library').length} library-routed), implementation_shaped=${scope.implementation_shaped}`)

// ---- Search + Fetch: search fans out per angle; fetch pipelines behind it per angle ----
const searchPrompt = (a) => {
  const base = `Research angle for the question "${question}":\n"${a.query}" (${a.rationale || 'no rationale given'}).\n`
  if (a.kind === 'library') return base +
    `This is a LIBRARY/FRAMEWORK angle. FIRST use ToolSearch to load the Context7 tools (resolve-library-id, query-docs) and query the official versioned docs for: ${JSON.stringify(scope.libraries || [])}. ` +
    `THEN use WebSearch for what docs cannot answer: real-world failure reports, GitHub issues, benchmarks, migration pain. Return the best sources (Context7 doc hits count as sources — use their canonical doc URL).`
  if (a.kind === 'recency') return base +
    `This is the RECENCY angle. Use WebSearch restricted to the current period (it is August 2026): changelogs, release notes, deprecation notices, "what's new" posts. Prefer official changelog/release URLs.`
  return base + `Use WebSearch. Prefer primary sources (official docs, changelogs, maintainer posts, papers) over aggregators. Return the best sources with a one-line "why" each.`
}

phase('Search')
const angleResults = await parallel(scope.angles.map(a => () =>
  agent(searchPrompt(a), { label: `search:${a.kind}`, phase: 'Search', schema: SEARCH_SCHEMA })))

// Barrier is deliberate: URL dedup needs ALL angles' results at once.
const seen = new Set()
const sources = []
for (const r of angleResults.filter(Boolean)) {
  for (const s of r.results) {
    const key = s.url.replace(/[#?].*$/, '').replace(/\/$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(s)
  }
}
const kept = sources.slice(0, SOURCE_CAP)
if (sources.length > kept.length) log(`NO-SILENT-CAPS: fetching ${kept.length}/${sources.length} deduped sources — dropped ${sources.length - kept.length} lowest-ranked (raise the budget to widen)`)
else log(`fetching all ${kept.length} deduped sources`)

const fetchStage = (src) => agent(
  `Fetch ${src.url} (WebFetch; if it fails, note that and return zero claims — do not substitute another URL). ` +
  `Extract up to 8 FALSIFIABLE claims relevant to: "${question}". A claim must be checkable-in-principle (a fact, a behavior, a version constraint, a benchmark number) — not an opinion. ` +
  `For each: the claim, a VERBATIM quote from the page supporting it, the url, its source_class (be honest: SEO content mills are 'seo_content'), and version_context if the claim is version-specific.`,
  { label: `fetch:${src.url.slice(0, 60)}`, phase: 'Fetch', schema: CLAIMS_SCHEMA },
)

// Verify lenses are DIVERSE, not redundant: each catches a failure mode the others cannot.
const LENSES = [
  { key: 'fidelity', prompt: (c) => `FIDELITY lens. Fetch ${c.url} and check: does this page ACTUALLY support the claim "${c.text}"? The extractor says the supporting quote is: "${c.quote}". If the quote is absent, altered, or out-of-context relative to the claim, refute. A dead/unfetchable page refutes (unverifiable citation).` },
  { key: 'recency', prompt: (c) => `RECENCY lens. It is August 2026. Is the claim "${c.text}" (version context: ${c.version_context || 'none stated'}) still true of the CURRENT stable version/state? Use WebSearch if needed (changelogs, release notes). Refute if superseded, deprecated, or version-ambiguous in a way that would mislead an implementer.` },
  { key: 'trust', prompt: (c) => `SOURCE-TRUST lens. The claim "${c.text}" comes from a ${c.source_class} source (${c.url}). For this class, is the claim independently corroborated? Use WebSearch to find ONE independent primary corroboration. official_docs/changelog claims pass on fidelity alone; blog/community/seo claims with NO independent corroboration are refuted.` },
]

const CLASS_CONFIDENCE = { official_docs: 0.95, changelog_or_release: 0.95, maintainer: 0.85, reputable_publication: 0.75, community: 0.6, blog: 0.5, seo_content: 0.3 }

const verifyStage = async (claimsResult) => {
  if (!claimsResult || !claimsResult.claims.length) return []
  return parallel(claimsResult.claims.map(c => async () => {
    const verdicts = await parallel(LENSES.map(l => () =>
      agent(l.prompt(c) + ` Default to refuted:true when uncertain.`, { label: `verify:${l.key}`, phase: 'Verify', schema: VERDICT_SCHEMA })))
    const live = verdicts.filter(Boolean)
    const refutes = live.filter(v => v.refuted)
    const killed = refutes.length >= 2
    return { ...c, killed, confidence: killed ? 0 : (CLASS_CONFIDENCE[c.source_class] ?? 0.5) * (1 - 0.25 * refutes.length), lens_notes: live.map((v, i) => `${LENSES[i]?.key ?? 'lens'}: ${v.refuted ? 'REFUTED — ' : 'ok'}${v.reason || ''}`) }
  }))
}

phase('Fetch')
const verified = (await pipeline(kept, fetchStage, verifyStage)).filter(Boolean).flat()

// ---- Completeness: one critic, at most one extra round ----
phase('Completeness')
const surviving = verified.filter(c => c && !c.killed)
const critic = await agent(
  `Completeness critic for the research question "${question}".\nAngles searched: ${JSON.stringify(scope.angles.map(a => a.query))}.\nSurviving verified claims (${surviving.length}): ${JSON.stringify(surviving.map(c => c.text)).slice(0, 6000)}.\n` +
  `What is MISSING to answer the question well — a modality not searched (GitHub issues? changelogs? benchmarks? the library's own test suite? academic/spec sources?), a sub-question with zero surviving claims, or an unresolved contradiction? ` +
  `If the evidence is sufficient, say so. Otherwise name at most 3 concrete follow-up queries.`,
  { label: 'completeness-critic', schema: CRITIC_SCHEMA },
)
if (critic && !critic.sufficient && critic.missing.length) {
  log(`critic found gaps — one extra round over ${critic.missing.length} follow-up queries`)
  const extraResults = await parallel(critic.missing.map(a => () =>
    agent(searchPrompt({ ...a, rationale: 'completeness follow-up' }), { label: `search2:${a.kind}`, phase: 'Completeness', schema: SEARCH_SCHEMA })))
  const extraSources = []
  for (const r of extraResults.filter(Boolean)) for (const s of r.results) {
    const key = s.url.replace(/[#?].*$/, '').replace(/\/$/, '')
    if (!seen.has(key)) { seen.add(key); extraSources.push(s) }
  }
  const extraKept = extraSources.slice(0, Math.max(5, Math.floor(SOURCE_CAP / 3)))
  if (extraSources.length > extraKept.length) log(`NO-SILENT-CAPS: follow-up round fetching ${extraKept.length}/${extraSources.length}`)
  const extraVerified = (await pipeline(extraKept, fetchStage, verifyStage)).filter(Boolean).flat()
  verified.push(...extraVerified.filter(Boolean))
}

// ---- Synthesize ----
phase('Synthesize')
const finalClaims = verified.filter(c => c && !c.killed)
const killedClaims = verified.filter(c => c && c.killed)
const SYNTH_SCHEMA = {
  type: 'object', required: ['report'],
  properties: {
    report: { type: 'string', description: 'full markdown report' },
    intake_seed: {
      type: 'object',
      description: 'ONLY when the question is implementation-shaped: a /feature intake seed',
      properties: {
        goal: { type: 'string' },
        existing_patterns_to_follow: { type: 'array', items: { type: 'string' } },
        edge_cases: { type: 'array', items: { type: 'string' } },
        tests_to_add: { type: 'array', items: { type: 'string' } },
        verification_commands: { type: 'array', items: { type: 'string' } },
        dependencies_added: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } },
      },
    },
  },
}
const synth = await agent(
  `Synthesize a research report for: "${question}".\n` +
  `VERIFIED claims (each has confidence + source): ${JSON.stringify(finalClaims.map(c => ({ text: c.text, url: c.url, source_class: c.source_class, confidence: c.confidence, version_context: c.version_context }))).slice(0, 30000)}\n` +
  `KILLED claims (do NOT use as facts; a "commonly claimed but refuted" section is valuable): ${JSON.stringify(killedClaims.map(c => ({ text: c.text, notes: c.lens_notes }))).slice(0, 8000)}\n` +
  `Report rules: merge semantic duplicates; order findings by confidence; EVERY factual statement carries an inline citation [n] with a source list; state version context wherever it matters; include the refuted-claims section; include a methodology footer (angles, sources fetched, claims verified/killed).\n` +
  (scope.implementation_shaped
    ? `This question is implementation-shaped: ALSO emit intake_seed — a /feature intake contract seed. tests_to_add must be VERBATIM test titles each naming the edge case or constraint it covers (the discovered failure modes become the eval set); verification_commands are concrete commands; open_questions only for genuinely unresolved forks.`
    : `This question is not implementation-shaped: omit intake_seed.`),
  { label: 'synthesize', schema: SYNTH_SCHEMA, effort: 'high' },
)

// ---- Optional spike: turn findings into a runnable proof ----
let spike = null
if (wantSpike && scope.implementation_shaped && synth?.intake_seed) {
  phase('Synthesize')
  spike = await agent(
    `Build a MINIMAL runnable spike proving the core finding of this research is implementable: "${synth.intake_seed.goal}".\n` +
    `Key verified constraints: ${JSON.stringify(finalClaims.slice(0, 12).map(c => c.text))}.\n` +
    `Rules: work in a fresh temp directory OUTSIDE any git repo; pin exact dependency versions; the spike must RUN (execute it and capture output); keep it under ~100 lines; it is throwaway proof, not production code. ` +
    `Return: the code, the exact commands to reproduce, the captured run output, and any finding the research got wrong (a spike that fails is a VALUABLE result — report the failure honestly, never fake success).`,
    { label: 'spike', phase: 'Synthesize' },
  )
}

return {
  report: synth?.report ?? '(synthesis failed — raw claims below)',
  intake_seed: synth?.intake_seed ?? null,
  spike,
  stats: {
    angles: scope.angles.length,
    sources_found: sources.length,
    sources_fetched: kept.length,
    claims_verified: finalClaims.length,
    claims_killed: killedClaims.length,
    implementation_shaped: scope.implementation_shaped,
  },
  raw_claims: finalClaims,
}
