// Native dialog wrappers. Like lib/api.ts, this is the only module that
// may import the dialog plugin — UI components go through these helpers.

import { open } from "@tauri-apps/plugin-dialog";

/** Native open-file dialog filtered to .epub. Resolves null on cancel. */
export async function pickEpubFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "EPUB", extensions: ["epub"] }],
  });
  return picked;
}
