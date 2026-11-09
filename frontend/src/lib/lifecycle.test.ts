import { describe, expect, it } from "vitest";
import {
  APP_NAME,
  EPUB_ONLY_MESSAGE,
  describeCreateError,
  describeOpenError,
  describeSaveError,
  fileName,
  firstEpub,
  isEpubPath,
  isNotFound,
  parentFolder,
  samePath,
  stripExtension,
  windowTitleFor,
} from "./lifecycle";

const notFound = {
  kind: "Io" as const,
  message: "cannot open /b/gone.epub: No such file or directory (os error 2)",
};

describe("path helpers", () => {
  it("splits OS paths on either separator, keeping Unicode", () => {
    expect(fileName("/Users/me/Livros/História 世界.epub")).toBe(
      "História 世界.epub",
    );
    expect(fileName("C:\\Books\\w.epub")).toBe("w.epub");
    expect(parentFolder("/Users/me/Livros/a.epub")).toBe("Livros");
    expect(parentFolder("/a.epub")).toBe("");
    expect(stripExtension("Book.v2.epub")).toBe("Book.v2");
    expect(stripExtension(".hidden")).toBe(".hidden");
  });

  it("recognises .epub case-insensitively", () => {
    expect(isEpubPath("/x/A.EPUB")).toBe(true);
    expect(isEpubPath("/x/a.epub.pdf")).toBe(false);
  });

  it("compares paths exactly", () => {
    expect(samePath("/a.epub", "/a.epub")).toBe(true);
    expect(samePath("/a.epub", "/A.epub")).toBe(false);
    expect(samePath(null, "/a.epub")).toBe(false);
  });
});

describe("firstEpub (drop / Finder batch policy)", () => {
  it("opens the first .epub and ignores the rest", () => {
    expect(firstEpub(["/a.pdf", "/b.epub", "/c.epub"])).toEqual({
      path: "/b.epub",
    });
  });
  it("explains when nothing is an EPUB", () => {
    expect(firstEpub(["/a.pdf", "/b.png"])).toEqual({
      error: EPUB_ONLY_MESSAGE,
    });
  });
  it("does nothing for an empty batch", () => {
    expect(firstEpub([])).toBeNull();
  });
});

describe("windowTitleFor", () => {
  it("is the app name at welcome", () => {
    expect(windowTitleFor(null)).toBe(APP_NAME);
  });
  it("is the file name without extension for a saved book", () => {
    expect(
      windowTitleFor({
        source: "/books/Minha História.epub",
        metadata: { title: "Something else" },
      }),
    ).toBe("Minha História");
  });
  it("is the book title for a book not on disk yet", () => {
    expect(
      windowTitleFor({ source: null, metadata: { title: "  物語  " } }),
    ).toBe("物語");
    expect(windowTitleFor({ source: null, metadata: { title: " " } })).toBe(
      APP_NAME,
    );
  });
});

describe("describeOpenError", () => {
  const path = "/books/Café.epub";
  it.each([
    [{ kind: "NotAnEpub", message: "mimetype" }, "“Café.epub” isn’t a valid EPUB file."],
    [
      { kind: "MalformedPackage", message: "bad opf" },
      "“Café.epub” couldn’t be opened because its package is damaged.",
    ],
    [
      { kind: "UnsupportedFeature", message: "encryption" },
      "“Café.epub” uses features epubzilla can’t open yet.",
    ],
    [
      { kind: "Io", message: "cannot open: No such file (os error 2)" },
      "“Café.epub” couldn’t be found. It may have been moved or deleted.",
    ],
    [
      { kind: "Io", message: "cannot open: Permission denied (os error 13)" },
      "“Café.epub” couldn’t be read.",
    ],
    [new Error("boom"), "“Café.epub” couldn’t be opened."],
  ])("maps %o to a readable sentence", (error, message) => {
    const notice = describeOpenError(error, path);
    expect(notice.message).toBe(message);
    expect(notice.details).not.toBeNull();
  });

  it("keeps the raw error as details", () => {
    expect(
      describeOpenError({ kind: "NotAnEpub", message: "mimetype" }, path)
        .details,
    ).toBe("NotAnEpub: mimetype");
  });
});

describe("isNotFound", () => {
  it("uses the errno suffix, not the localized text", () => {
    expect(isNotFound(notFound)).toBe(true);
    expect(isNotFound({ kind: "Io", message: "Datei nicht gefunden (os error 2)" })).toBe(
      true,
    );
    expect(isNotFound({ kind: "Io", message: "denied (os error 13)" })).toBe(false);
    expect(isNotFound({ kind: "NotAnEpub", message: "(os error 2)" })).toBe(false);
  });
});

describe("describeSaveError", () => {
  it("offers Save As when an in-place save fails on I/O", () => {
    const notice = describeSaveError(
      { kind: "Io", message: "disk gone" },
      "/v/b.epub",
      true,
    );
    expect(notice.message).toBe(
      "“b.epub” couldn’t be saved to its original location.",
    );
    expect(notice.action).toBe("save-as");
  });
  it("does not offer Save As for a failed Save As", () => {
    const notice = describeSaveError(
      { kind: "Io", message: "denied" },
      "/v/b.epub",
      false,
    );
    expect(notice.action).toBeUndefined();
  });
  it("describes creation failures", () => {
    expect(describeCreateError({ kind: "Io", message: "x" }).message).toBe(
      "The book couldn’t be created.",
    );
  });
});
