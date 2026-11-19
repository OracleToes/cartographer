import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

const configPath = join(home, "config.json");
try {
  await readFile(configPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await writeFile(
    configPath,
    `${JSON.stringify({ version: 1, model: "provider/model", collapseMode: "request" }, null, 2)}\n`,
    "utf8",
  );
}

const installed = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev"], {
  cwd: home,
  stdio: "inherit",
});
if (installed.status !== 0) process.exit(installed.status ?? 1);

process.stdout.write(`Installed Cartographer Mini in ${home}\n`);
process.stdout.write(`Run ${join(home, "bin", "carto.mjs")} from a project directory.\n`);
