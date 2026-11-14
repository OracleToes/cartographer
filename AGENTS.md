# Agent instructions

## Tests are disabled

Do not run tests, test suites, test files, test runners, or test-related package scripts in this repository unless the user explicitly asks for test execution in the current conversation. This restriction overrides generic instructions to run tests during verification. Do not interpret authorization to implement, finish a stage, or perform final verification as permission to run tests. If the user has not explicitly asked to run tests, use non-test checks only and report that tests were not run.

The former test suite and harness were removed at the user's direction. `npm test` is intentionally hard-blocked in `package.json`; do not bypass or alter that guard. Never restore the removed suite unless the user explicitly requests it.
