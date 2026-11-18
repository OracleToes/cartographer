// Screen-facing names for the asynchronous clipboard adapter. The screen owns the wording around a copy; process
// and filesystem work live at the infrastructure edge so key dispatch and rendering never wait on them.
export { copyOut, selectionText, toClipboard } from "../infrastructure/clipboard.mjs";
