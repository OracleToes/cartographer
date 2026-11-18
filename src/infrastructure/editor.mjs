// The screen yields its terminal while an external editor runs. Keep process waiting out of rendering and input code.
import { spawn } from "node:child_process";

/** Run one configured editor command and resolve its exit state without blocking the event loop. */
export function launchEditor(command) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, { stdio: "inherit", shell: true });
		} catch (error) {
			resolve({ error });
			return;
		}
		child.once("error", (error) => resolve({ error }));
		child.once("close", (status, signal) => resolve({ status, signal }));
	});
}
