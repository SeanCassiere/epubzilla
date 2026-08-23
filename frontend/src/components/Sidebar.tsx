import { useState } from "react";
import { useReader } from "../state/reader";
import { resourceUrl } from "../lib/api";
import { TocSidebar } from "./TocSidebar";
import { ChapterPanel } from "./ChapterPanel";
import { ValidationPanel } from "./ValidationPanel";

type Tab = "contents" | "chapters" | "checks";

/**
 * Sidebar column with three tabs: "Contents" is the M1.4 TOC tree
 * (unchanged), "Chapters" is the M2.3 chapter management panel, "Checks"
 * is the issue #72 validation panel. Mounted keyed by book.id (App.tsx)
 * so tab choice and TOC expansion reset per book; only the active panel
 * is mounted.
 */
export function Sidebar() {
  const { book } = useReader();
  const [tab, setTab] = useState<Tab>("contents");
  if (book === null) return null;

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      className={"sidebar-tab" + (tab === id ? " sidebar-tab-active" : "")}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  // Current cover (issue #73), shown above the tabs when the book has one.
  const cover =
    book.metadata.cover_resource !== null
      ? (book.resources.find((r) => r.id === book.metadata.cover_resource) ??
        null)
      : null;

  return (
    <div className="sidebar">
      {cover !== null && (
        <img
          className="sidebar-cover"
          src={resourceUrl(book.id, cover.path)}
          alt={`Cover of ${book.metadata.title}`}
        />
      )}
      <div className="sidebar-tabs" role="tablist" aria-label="Sidebar panels">
        {tabButton("contents", "Contents")}
        {tabButton("chapters", "Chapters")}
        {tabButton("checks", "Checks")}
      </div>
      {tab === "contents" ? (
        <TocSidebar />
      ) : tab === "chapters" ? (
        <ChapterPanel />
      ) : (
        <ValidationPanel />
      )}
    </div>
  );
}
