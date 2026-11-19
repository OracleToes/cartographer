import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = resolve(process.env.CARTO_HOME ?? join(homedir(), ".carto"));

await mkdir(home, { recursive: true });
for (const name of ["src", "dist", "bin"]) {
  await rm(join(home, name), { recursive: true, force: true });
  await cp(join(root, name), join(home, name), { recursive: true });
}
for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) {
  await cp(join(root, name), join(home, name));
}

const installed = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev"], {
  cwd: home,
  stdio: "inherit",
});
if (installed.status !== 0) process.exit(installed.status ?? 1);

process.stdout.write(`Installed Cartographer Mini in ${home}\n`);
process.stdout.write(`Add ${join(home, "bin")} to PATH, then run carto from a project directory.\n`);
process.stdout.write(`On first use, add --model provider/model to create ${join(home, "config.json")}.\n`);
