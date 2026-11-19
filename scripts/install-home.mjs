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

const bin = join(home, "bin");
process.stdout.write(`Installed Carto in ${home}\n`);
process.stdout.write(`For this shell, run: export PATH="${bin}:$PATH"\n`);
process.stdout.write("Then run: hash -r\n");
process.stdout.write(`On first use, run carto --model provider/model to create ${join(home, "config.json")}.\n`);
process.stdout.write("For keyless llama-swap, use: carto --model llama-swap/Flint --endpoint http://localhost:8888/v1\n");
