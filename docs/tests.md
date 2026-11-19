Run a sustained cleanup campaign across this repository's tests. Make every retained test earn its execution and maintenance cost.

Read each subsystem's production code before its tests. Identify the behavior contracts and realistic regressions worth protecting. Remove obsolete tests, implementation-mirroring assertions, duplicate coverage, unused fixtures and unnecessary mocks. Consolidate overlapping tests around the strongest behavior checks. Repair valuable flaky tests instead of preserving their retry tax.

Treat deletions and consolidation as first-class deliverables. Follow the repository’s test-line budget; justify genuinely new coverage rather than padding a replacement suite. Never offset growth by deleting an independent safety contract.

Do not stop after easy deletions or a small first PR. Work through every in-scope subsystem. Keep a ledger of completed areas, removed duplication, remaining contract coverage and unresolved risks; resume from it until the campaign is complete. Do not chase a deletion percentage or add replacement tests just to keep the count up.

For each change, run the affected checks and demonstrate that the retained test fails for the relevant broken behavior when practical. Never delete the only useful regression guard to make a failure disappear. Keep platform and integration boundaries that protect distinct behavior.

Validate and land narrow PRs within the repository's existing review and merge rules. Continue until every in-scope area is checked or has a precise blocker. No releases.