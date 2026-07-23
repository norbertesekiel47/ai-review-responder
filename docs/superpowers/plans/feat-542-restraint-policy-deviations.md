# feat/542 restraint-policy — plan deviations

- **Task 1, Step 3 (`utcDayNumber`)**: the plan's destructuring
  `const [year, month, day] = date.slice(0, 10).split('-').map(Number)` fails
  `pnpm typecheck` under this repo's strict settings (`noUncheckedIndexedAccess`
  makes each destructured element `number | undefined` → TS18048/TS2345 at the
  `Date.UTC(year, month - 1, day)` call). Minimal fix applied: parse the three
  components with fixed-position `Number(date.slice(...))` calls
  (`0–4`, `5–7`, `8–10`). Behavior is identical for the trusted
  `YYYY-MM-DD`/ISO inputs the module's precondition guarantees; no logic or
  interface change.
