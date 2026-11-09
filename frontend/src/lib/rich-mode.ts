// GFM rejects whitespace-bearing footnote labels and can escape punctuation
// differently in references and definitions. Until the editor can preserve
// these identities, keep the entire original buffer in Markdown mode.
// This deliberately conservative scan also covers labels in literal examples;
// it must run before remark can reinterpret a definition as a link target.
export function richModeUnavailableReason(markdown: string): string | null {
  for (const match of markdown.matchAll(/\[\^([^\]]+)\]/g)) {
    if (!/^[A-Za-z0-9-]+$/.test(match[1])) {
      return "This chapter contains footnote labels with spaces or special characters that WYSIWYG cannot preserve. Edit in Markdown mode to keep the notes intact.";
    }
  }
  return null;
}
