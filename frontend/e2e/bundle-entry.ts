// Entry for the engine-test bundle (see global-setup.ts): exposes the
// REAL production chapter pipeline and pagination driver to the WebKit
// test pages as a single IIFE global (`EpubzillaReader`), so the specs in
// this directory exercise the exact code ReaderPane runs — not copies.
export * from "../src/lib/chapter";
export * from "../src/lib/paginator";
