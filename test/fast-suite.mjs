// These independent suites do not mutate process-wide state. Loading them in
// one test worker keeps every assertion while avoiding repeated Node startups.
import "./brain.test.mjs";
import "./brain-store.test.mjs";
import "./freshness.test.mjs";
import "./gitignore.test.mjs";
import "./handles.test.mjs";
import "./project-tree.test.mjs";
import "./projection.test.mjs";
import "./state-block.test.mjs";
import "./ui-views.test.mjs";
import "./compose.test.mjs";
import "./person.test.mjs";
