// Deferred reference labels for interactive clients. The durable catalog/atlas describer remains the authority, but
// a screen can show an opaque id immediately and fill in its friendly label after the current render/key stack ends.
import { createRefDescriber } from "../refs.mjs";
import { yieldToUi } from "./defer.mjs";

const referenceKey = (ref) => {
	if (ref === null || typeof ref !== "object") return undefined;
	const kind = typeof ref.kind === "string" && ref.kind !== "" ? ref.kind : undefined;
	const id = typeof ref.id === "string" && ref.id !== "" ? ref.id : undefined;
	return kind === undefined || id === undefined ? undefined : `${kind}:${id}`;
};

/**
 * @param {{ brainDir: string, onResolved?: (ref: object, label: string) => void }} options
 * @returns {{ describe: (ref: object) => string | undefined, dispose: () => void }}
 */
export function createDeferredReferenceLabels({ brainDir, onResolved = () => {} }) {
	const legacy = createRefDescriber({ brainDir });
	const labels = new Map();
	const pending = new Set();
	let disposed = false;
	const resolve = (ref, key) => {
		if (pending.has(key)) return;
		pending.add(key);
		void (async () => {
			await yieldToUi();
			let label;
			try { label = legacy(ref); } catch { label = typeof ref?.id === "string" ? ref.id : undefined; }
			pending.delete(key);
			if (disposed || typeof label !== "string" || label === "") return;
			const prior = labels.get(key);
			labels.set(key, label);
			if (prior !== label) onResolved(ref, label);
		})();
	};
	return Object.freeze({
		describe(ref) {
			const key = referenceKey(ref);
			if (key === undefined) return undefined;
			const cached = labels.get(key);
			if (cached !== undefined) return cached;
			resolve(ref, key);
			return ref.id;
		},
		dispose() {
			disposed = true;
			pending.clear();
		},
	});
}
