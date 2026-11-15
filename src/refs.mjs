// How a reference reads to a person: the name it points at, with the id in parentheses, so a line in the chat says
// `index.html (f1)` and not a bare `f1`. A describer is cheap to call in a render loop: it re-reads the catalog or
// the graph only when the file they live in changed, and it never throws into a render path.
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { atlasPath, loadAtlas } from "./atlas.mjs";

const stampOf = (path) => {
	try {
		const info = statSync(path);
		return `${info.mtimeMs}:${info.size}`;
	} catch {
		return undefined;
	}
};

/**
 * @param {{ brainDir: string }} who
 * @returns {(ref: { kind?: unknown, id?: unknown }) => string | undefined} undefined when the ref is not one we can
 *   name; the id when we can see no name for it.
 */
export function createRefDescriber({ brainDir }) {
	const labels = new Map();
	let catalogStamp;
	let catalog;
	let atlasStamp;
	let atlas;
	const catalogNow = () => {
		const stamp = existsSync(join(brainDir, "catalog.json")) ? stampOf(join(brainDir, "catalog.json")) : undefined;
		if (stamp !== catalogStamp) {
			catalogStamp = stamp;
			try {
				catalog = loadCatalog(brainDir);
			} catch {
				catalog = undefined;
			}
			labels.clear();
		}
		return catalog;
	};
	const atlasNow = () => {
		const stamp = existsSync(atlasPath(brainDir)) ? stampOf(atlasPath(brainDir)) : undefined;
		if (stamp !== atlasStamp) {
			atlasStamp = stamp;
			atlas = loadAtlas(brainDir).atlas;
			labels.clear();
		}
		return atlas;
	};
	return (ref) => {
		try {
			if (ref === null || typeof ref !== "object") return undefined;
			const kind = typeof ref.kind === "string" ? ref.kind : "";
			const id = typeof ref.id === "string" ? ref.id : "";
			if (kind === "" || id === "") return undefined;
			const key = `${kind} ${id}`;
			const known = labels.get(key);
			if (known !== undefined) return known;
			let label;
			if (kind === "file") {
				const record = catalogNow()?.files.find((file) => file.id === id);
				if (typeof record?.path === "string" && record.path !== "") label = `${basename(record.path)} (${id})`;
			} else if (kind === "atlas") {
				const node = atlasNow()?.nodes.find((entry) => entry.id === id);
				if (node?.name) label = `${node.name} (${id})`;
			}
			if (label === undefined) label = id;
			labels.set(key, label);
			return label;
		} catch {
			return typeof ref?.id === "string" ? ref.id : undefined;
		}
	};
}
