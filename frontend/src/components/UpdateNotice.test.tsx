import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UpdateNotice } from "./UpdateNotice";
import {
  checkForUpdateAfterLaunch,
  openLatestRelease,
} from "../lib/updater";

vi.mock("../lib/updater", () => ({
  checkForUpdateAfterLaunch: vi.fn(),
  openLatestRelease: vi.fn(),
}));

const mockedCheck = vi.mocked(checkForUpdateAfterLaunch);
const mockedOpen = vi.mocked(openLatestRelease);

beforeEach(() => {
  vi.clearAllMocks();
  mockedOpen.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("UpdateNotice", () => {
  it.each(["unavailable", "failed"] as const)(
    "stays visually silent when the check is %s",
    async (status) => {
      mockedCheck.mockResolvedValue({ status });
      render(<UpdateNotice />);

      await waitFor(() => expect(mockedCheck).toHaveBeenCalledOnce());
      expect(screen.queryByLabelText("Update available")).toBeNull();
    },
  );

  it("shows the version and makes the manual handoff once", async () => {
    mockedCheck.mockResolvedValue({ status: "available", version: "0.4.0" });
    render(<UpdateNotice />);

    const notice = await screen.findByLabelText("Update available");
    expect(notice.textContent).toContain("0.4.0");
    expect(notice.textContent).toContain("manual");
    expect(notice.textContent).toContain("stay open");

    const view = screen.getByRole("button", { name: "View release" });
    fireEvent.click(view);
    fireEvent.click(view);
    expect(mockedOpen).toHaveBeenCalledOnce();
  });

  it("dismisses for the mounted app session without touching sibling state", async () => {
    mockedCheck.mockResolvedValue({ status: "available", version: "0.4.0" });
    render(
      <>
        <output aria-label="editor buffer">unsaved chapter text</output>
        <UpdateNotice />
      </>,
    );

    await screen.findByLabelText("Update available");
    fireEvent.click(screen.getByRole("button", { name: "View release" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));

    expect(screen.queryByLabelText("Update available")).toBeNull();
    expect(screen.getByLabelText("editor buffer").textContent).toBe(
      "unsaved chapter text",
    );
    expect(mockedOpen).toHaveBeenCalledOnce();
  });
});
