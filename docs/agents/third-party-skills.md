# Third-party skills

Skills under `.agents/skills/` and `.claude/skills/` that are adapted from
another project. Each was read in full before it was adapted; none is installed
as a plugin, so none brings a router, a command set, or a hook with it.

| Skill | Source | Snapshot | What changed |
|---|---|---|---|
| `security-and-hardening` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | `c004a74` (2026-09-17) | Runs at plan time. Express/bcrypt/helmet examples replaced by RepWorth's own seams and invariants. Adds "Where generic advice is wrong here" (fail-open limiters, Supabase-owned credentials, Railway ingress). |
| `constraint-driven-development` | same | same | The interview and `CONSTRAINTS.md` are removed: the bar already has owners here (`ci:*`, the wiring test, fallow, the invariants). Keeps the five "guard the bar" moves, mapped to `pnpm ci:weakened-checks`, plus circularity, placement, and ratchets. |
| `doubt-driven-development` | same | same | Scoped to work OUTSIDE a guarded `/feature` run, where the plan skeptic and the review wave already do this. Cross-model is offered for high-stakes decisions, not every cycle. References to that pack's personas are removed. |

To compare with upstream, read the same skill at the snapshot commit.

## Notice — addyosmani/agent-skills

MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
