import { beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  LATEST_RELEASE_URL,
  checkForUpdateAfterLaunch,
  openLatestRelease,
  resetUpdaterSessionForTests,
} from "./updater";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const mockedCheck = vi.mocked(check);
const mockedOpenUrl = vi.mocked(openUrl);

beforeEach(() => {
  resetUpdaterSessionForTests();
  vi.clearAllMocks();
});

describe("launch update check", () => {
  it("reports no update without creating UI metadata", async () => {
    mockedCheck.mockResolvedValue(null);

    await expect(checkForUpdateAfterLaunch()).resolves.toEqual({
      status: "unavailable",
    });
    expect(mockedCheck).toHaveBeenCalledWith({ timeout: 10_000 });
  });

  it("extracts only the version and closes an available Update resource", async () => {
    const close = vi.fn(async () => undefined);
    mockedCheck.mockResolvedValue({
      version: "0.4.0",
      currentVersion: "0.3.0",
      body: "release notes",
      date: "2026-08-24",
      rawJson: { platforms: {} },
      close,
    } as never);

    await expect(checkForUpdateAfterLaunch()).resolves.toEqual({
      status: "available",
      version: "0.4.0",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed manifest", new Error("invalid manifest JSON")],
    ["offline request", new Error("network unavailable")],
    ["timeout", new Error("request timed out")],
  ])("turns a %s into a diagnostic failed state", async (_case, failure) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockedCheck.mockRejectedValue(failure);

    await expect(checkForUpdateAfterLaunch()).resolves.toEqual({
      status: "failed",
    });
    expect(warning).toHaveBeenCalledWith("Update check failed", failure);
    warning.mockRestore();
  });

  it("deduplicates launch checks, including concurrent Strict Mode effects", async () => {
    mockedCheck.mockResolvedValue(null);

    const first = checkForUpdateAfterLaunch();
    const second = checkForUpdateAfterLaunch();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mockedCheck).toHaveBeenCalledOnce();
  });
});

it("opens the exact release URL at most once", async () => {
  mockedOpenUrl.mockResolvedValue(undefined);

  const first = openLatestRelease();
  const second = openLatestRelease();

  expect(second).toBe(first);
  await Promise.all([first, second]);
  expect(mockedOpenUrl).toHaveBeenCalledOnce();
  expect(mockedOpenUrl).toHaveBeenCalledWith(LATEST_RELEASE_URL);
});
