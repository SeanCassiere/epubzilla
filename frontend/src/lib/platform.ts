// Platform detection for chrome-level layout decisions (issue #61).
//
// The macOS build uses an overlay titlebar (tauri.macos.conf.json), so the
// shell must reserve space for the traffic lights. Windows/Linux keep their
// native titlebar and need no inset. Detection is via the webview's
// navigator rather than @tauri-apps/plugin-os: it is synchronous (no async
// gap where the layout would jump on first paint) and WKWebView always
// reports a Mac platform. jsdom reports "" so tests exercise the
// no-inset path by default.

export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/i.test(navigator.platform || navigator.userAgent || "");
}
