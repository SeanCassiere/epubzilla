import { describe, expect, it } from "vitest";
import {
  nextThemePreference,
  parseThemePreference,
  resolveReadingTheme,
  themePreferenceLabel,
} from "./theme";

describe("parseThemePreference", () => {
  it("accepts the two explicit schemes", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
  });

  it("falls back to auto for anything else", () => {
    expect(parseThemePreference("auto")).toBe("auto");
    expect(parseThemePreference(null)).toBe("auto");
    expect(parseThemePreference(undefined)).toBe("auto");
    expect(parseThemePreference("neon")).toBe("auto");
    expect(parseThemePreference(42)).toBe("auto");
  });
});

describe("resolveReadingTheme", () => {
  it("auto follows the system scheme", () => {
    expect(resolveReadingTheme("auto", false)).toBe("light");
    expect(resolveReadingTheme("auto", true)).toBe("dark");
  });

  it("explicit preferences override the system scheme", () => {
    expect(resolveReadingTheme("light", true)).toBe("light");
    expect(resolveReadingTheme("dark", false)).toBe("dark");
  });
});

describe("nextThemePreference", () => {
  it("cycles auto -> light -> dark -> auto", () => {
    expect(nextThemePreference("auto")).toBe("light");
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("auto");
  });
});

describe("themePreferenceLabel", () => {
  it("labels every preference", () => {
    expect(themePreferenceLabel("auto")).toBe("Theme: Auto");
    expect(themePreferenceLabel("light")).toBe("Theme: Light");
    expect(themePreferenceLabel("dark")).toBe("Theme: Dark");
  });
});
