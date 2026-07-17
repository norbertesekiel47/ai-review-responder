# Architecture review log

Entropy counter for the `/feature` workflow (feature.md step 8): every merged
feature increments the counter. At **≥ 5 merges** since the last architecture
pass, the orchestrator reminds the user to schedule an architecture review
session (the user's call — never started automatically). A completed pass
resets the counter to 0 and adds a row below.

**Merges since last architecture pass: 0**

| Date | Trigger | Scope reviewed | Outcome |
|------|---------|----------------|---------|
| 2026-07-17 | baseline (log created) | — | counter initialized |
