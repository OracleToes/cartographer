// Shared screen helpers that are not a feature renderer.
//
// Migrated feature renderers live beside their capability groups: Runtime in runtime.mjs, Workspace in workspace.mjs,
// and Review in review.mjs. This narrow helper keeps the existing editor handoff independent of those projections.

/**
 * The command that opens a file in the user's editor, at a line when the editor is known to take one.
 * @returns {string} a shell command
 */
export function editorCommand(editor, file, line) {
	const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
	const name = String(editor).trim().split(/\s+/)[0].split("/").at(-1);
	if (line === undefined || !Number.isInteger(line) || line < 1) return `${editor} ${quote(file)}`;
	if (["code", "code-insiders", "codium", "cursor", "windsurf"].includes(name)) return `${editor} --goto ${quote(`${file}:${line}`)}`;
	if (["hx", "helix", "zed", "subl"].includes(name)) return `${editor} ${quote(`${file}:${line}`)}`;
	// vi, vim, nvim, nano, emacs, micro, kak, joe, ne, mg and most others take +LINE.
	return `${editor} +${line} ${quote(file)}`;
}
