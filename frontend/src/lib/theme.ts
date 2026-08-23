// Reading-theme preference logic for the reader (issue #78).
//
// Pure helpers so the resolution/cycling rules are unit-testable without
// DOM APIs. The preference is what the user picked in the reader UI
// ("auto" follows the system color scheme); the resolved ReadingTheme is
// what prepareChapterHtml receives.

import type { ReadingTheme } from "./chapter";

/** User-facing preference: follow the system, or force one scheme. */
export type ThemePreference = "auto" | "light" | "dark";

/** localStorage key for the persisted reading-theme preference. */
export const THEME_STORAGE_KEY = "epubzilla.reading-theme";

/** Narrows an unknown stored value to a ThemePreference (default "auto"). */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "auto";
}

/** Resolves the preference against the current system scheme. */
export function resolveReadingTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ReadingTheme {
  if (preference === "auto") return systemDark ? "dark" : "light";
  return preference;
}

/** Toggle order: auto -> light -> dark -> auto. */
export function nextThemePreference(
  preference: ThemePreference,
): ThemePreference {
  switch (preference) {
    case "auto":
      return "light";
    case "light":
      return "dark";
    case "dark":
      return "auto";
  }
}

/** Button label for the current preference. */
export function themePreferenceLabel(preference: ThemePreference): string {
  switch (preference) {
    case "auto":
      return "Theme: Auto";
    case "light":
      return "Theme: Light";
    case "dark":
      return "Theme: Dark";
  }
}
