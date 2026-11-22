import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openBrain } from "./dist/runtime/brain-store.js";
import { runTui } from "./dist/ui/app.js";

const root = mkdtempSync(join(tmpdir(), "carto-probe-"));
mkdirSync(join(root, ".brain"), { recursive: true });
mkdirSync(join(root, "src", "domain"), { recursive: true });
mkdirSync(join(root, "src", "ui"), { recursive: true });
writeFileSync(join(root, "src", "domain", "brain.ts"), "export const brain = 1;\n");
writeFileSync(join(root, "src", "ui", "app.ts"), "export const app = 1;\n");
writeFileSync(join(root, "README.md"), "# probe\n");
for (let i = 1; i <= 40; i += 1) writeFileSync(join(root, `file-${String(i).padStart(2, "0")}.ts`), `export const n = ${i};\n`);
const brain = await openBrain(join(root, ".brain", "brain.sqlite"));

const faux = fauxProvider({ provider: "faux-test", models: [{ id: "faux-model", contextWindow: 100_000 }] });
const models = createModels();
models.setProvider(faux.provider);

const write = process.stdout.write.bind(process.stdout);
let seen = "";
process.stdout.write = (chunk, ...rest) => { seen += String(chunk); return write(chunk, ...rest); };

setTimeout(() => { process.stdin.emit("data", Buffer.from("\u000f")); }, 600);
setTimeout(() => { process.stdin.emit("data", Buffer.from("t")); }, 900);
for (let i = 0; i < 30; i += 1) setTimeout(() => { process.stdin.emit("data", Buffer.from("j")); }, 1200 + i * 40);
setTimeout(() => { process.stdin.emit("data", Buffer.from("\u000b")); }, 2600);
setTimeout(() => { process.stdin.emit("data", Buffer.from("\u0003")); }, 2000);
setTimeout(() => { process.stdin.emit("data", Buffer.from("\u0003")); }, 2300);

const code = await runTui({ root, brain, models, model: { provider: "faux-test", modelId: "faux-model" } });
process.stdout.write = write;
await brain.close();
rmSync(root, { recursive: true, force: true });

const plain = seen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const last = plain.slice(plain.lastIndexOf(" WORKSPACE") - 200);
if (process.env.DUMP) console.log(last);
console.log("exit:", code);
for (const needle of ["TREE", "D1", "F1", "file-", "depth", "read F"]) {
  console.log(needle.padEnd(10), plain.includes(needle) ? "seen" : "MISSING");
}
