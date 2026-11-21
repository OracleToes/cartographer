# Tests audit

Run a sustained cleanup campaign across this repository's tests. Make every
retained test earn its execution and maintenance cost. Read each subsystem's
production code before its tests. Identify the behavior contracts and
realistic regressions worth protecting. Remove obsolete tests,
implementation-mirroring assertions, duplicate coverage, unused fixtures and
unnecessary mocks. Consolidate overlapping tests around the strongest behavior
checks. Repair valuable flaky tests instead of preserving their retry tax.
Treat deletions and consolidation as first-class deliverables.

This repository's budget is time, not lines: the whole suite runs once, at the
end of the stage, and must finish inside its fixed wall-clock limit. A run
that overruns is a failure, not a pass. There are no per-change checks and no
partial runs — a change is verified by the whole suite, not by the tests that
happen to touch it. Justify genuinely new coverage by naming the break it
catches, never by padding a replacement suite, and never offset growth by
deleting an independent safety contract.

Do not stop after easy deletions or a small first push. Work through every
in-scope subsystem. Keep a ledger of completed areas, removed duplication,
remaining contract coverage and unresolved risks; resume from it until the
campaign is complete. Do not chase a deletion percentage or add replacement
tests just to keep the count up. Demonstrate a retained guard by naming the
break it catches and reading the code that would trip it; a throwaway check
against deliberately broken code is the only exception, and it happens after
the push and is never kept. Never delete the only useful regression guard to
make a failure disappear. Keep platform and integration boundaries that
protect distinct behavior — one of each, not one per test.
