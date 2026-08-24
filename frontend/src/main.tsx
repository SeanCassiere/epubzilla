import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isMacOS } from "./lib/platform";

// Stamp the platform on <html> before first paint (issue #61): the macOS
// build has a transparent window with a vibrancy material behind the
// webview, and App.css keys the transparent-shell / opaque-content
// layering plus the overlay-titlebar insets off this attribute.
if (isMacOS()) {
  document.documentElement.dataset.platform = "macos";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
