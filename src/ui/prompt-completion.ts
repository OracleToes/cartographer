import { CombinedAutocompleteProvider, type Editor } from "@earendil-works/pi-tui";

/** Complete paths from the project, without slash commands or fuzzy @ attachments. */
export function enablePromptPathCompletion(editor: Editor, root: string): void {
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], root));
}
