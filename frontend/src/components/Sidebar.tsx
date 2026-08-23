import { useState } from "react";
import { useReader } from "../state/reader";
import { TocSidebar } from "./TocSidebar";
import { ChapterPanel } from "./ChapterPanel";

type Tab = "contents" | "chapters";

/**
 * Sidebar column with two tabs: "Contents" is the M1.4 TOC tree
 * (unchanged), "Chapters" is the M2.3 chapter management panel. Mounted
 * keyed by book.id (App.tsx) so tab choice and TOC expansion reset per
 * book; only the active panel is mounted.
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

  return (
    <div className="sidebar">
      <div className="sidebar-tabs" role="tablist" aria-label="Sidebar panels">
        {tabButton("contents", "Contents")}
        {tabButton("chapters", "Chapters")}
      </div>
      {tab === "contents" ? <TocSidebar /> : <ChapterPanel />}
    </div>
  );
}
