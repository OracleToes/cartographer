// These independent suites do not mutate process-wide state. Loading them in
// one test worker keeps every assertion while avoiding repeated Node startups.
await import("./brain.test.mjs");
await import("./brain-store.test.mjs");
await import("./freshness.test.mjs");
await import("./gitignore.test.mjs");
await import("./handles.test.mjs");
await import("./project-tree.test.mjs");
await import("./projection.test.mjs");
await import("./state-block.test.mjs");
await import("./ui-views.test.mjs");
await import("./compose.test.mjs");
await import("./person.test.mjs");
