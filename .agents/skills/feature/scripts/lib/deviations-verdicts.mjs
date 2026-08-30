// Audits a /feature deviations file against the read-back contract: every
// real entry carries a resolved **Verdict:** line (ACCEPT, or RE-PLAN which
// invokes the abort criteria). Feature 719 reached its branch review with two
// verdicts still "pending" despite the file promising to resolve them — the
// `reviewed` transition now refuses that instead of trusting the promise.
//
// Section model (matches docs/superpowers/plans/*-deviations.md as written):
//   - An entry is a `## ` heading and the lines under it.
//   - The template section's heading contains `<` placeholders — skipped.
//   - "Surface amendment log" is an index table, not an entry — skipped.
//   - Every other section must contain at least one `**Verdict:**` line, and
//     every verdict line in it must resolve to ACCEPT or RE-PLAN. RE-PLAN is
//     reported as its own problem: it means abort criteria, not review-ready.

export function auditDeviationVerdicts(markdown) {
  const sections = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = { heading: heading[1].trim(), verdicts: [] };
      sections.push(current);
      continue;
    }
    const verdict = line.match(/^\s*\*\*Verdict:\*\*\s*(.*)$/);
    if (verdict && current) current.verdicts.push(verdict[1].trim());
  }

  const problems = [];
  for (const section of sections) {
    if (section.heading.includes('<')) continue; // template entry
    if (/^surface amendment log$/i.test(section.heading)) continue; // index table
    if (section.verdicts.length === 0) {
      problems.push(`no **Verdict:** line: "${section.heading}"`);
      continue;
    }
    for (const verdict of section.verdicts) {
      if (/\bRE-PLAN\b/.test(verdict)) {
        problems.push(`RE-PLAN verdict (abort criteria apply): "${section.heading}"`);
      } else if (!/\bACCEPT\b/.test(verdict)) {
        problems.push(`unresolved verdict "${verdict || '(empty)'}": "${section.heading}"`);
      }
    }
  }
  return { sectionCount: sections.length, problems };
}
