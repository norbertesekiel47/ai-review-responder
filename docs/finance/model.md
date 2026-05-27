# Three-Scenario Financial Model

Monthly growth / churn / gross-margin assumptions for planning. Revisit each
monthly close against actuals.

| Scenario | Monthly growth | Monthly churn | Gross margin |
|---|---|---|---|
| Conservative | 5% | 4% | 60% |
| Base | 10% | 2% | 75% |
| Ambitious | 15% | 1% | 80% |

**How to use:**
- Project MRR forward: `MRR_next = MRR * (1 + growth − churn)`.
- Apply the scenario gross margin to estimate contribution after variable COGS.
- Sanity-check the gross-margin assumption against the actual platform margin in
  `/admin/costs` + the vendor COGS from `cogs-template.md`. If actual API-COGS
  margin is already below the scenario assumption before vendor COGS, the
  scenario is optimistic.
- Conservative is the planning floor (runway decisions); ambitious is the
  upside case, not the plan of record.
