// Cover management (issue #73): shown at the top of the edit-metadata
// dialog. Set or replace the cover from an image file on disk, reuse an
// image already in the book, or remove the cover. Unlike the form fields
// below it, cover actions are core mutations that apply immediately (they
// mark the book dirty and are persisted by the next save); the core gives
// the manifest item the EPUB 3 `cover-image` property and cleans up a
// replaced session-added cover.

import { useReader } from "../state/reader";
import { resourceUrl } from "../lib/api";
import { pickImageFile } from "../lib/dialog";

export function CoverPicker() {
  const { book, setCover, setCoverFromFile } = useReader();
  if (book === null) return null;

  const coverId = book.metadata.cover_resource;
  const cover =
    coverId !== null
      ? (book.resources.find((r) => r.id === coverId) ?? null)
      : null;
  const images = book.resources.filter((r) =>
    r.media_type.startsWith("image/"),
  );

  const chooseFile = async () => {
    const path = await pickImageFile();
    if (path !== null) await setCoverFromFile(path);
  };

  return (
    <section className="cover-picker" aria-label="Cover image">
      <span className="metadata-label">Cover</span>
      <div className="cover-picker-body">
        {cover !== null ? (
          <img
            className="cover-thumb"
            src={resourceUrl(book.id, cover.path)}
            alt={`Current cover (${cover.path})`}
          />
        ) : (
          <div className="cover-thumb cover-thumb-empty">No cover</div>
        )}
        <div className="cover-picker-actions">
          <button type="button" onClick={() => void chooseFile()}>
            {cover !== null ? "Replace from file…" : "Choose image file…"}
          </button>
          {images.length > 0 && (
            <select
              aria-label="Use an image from the book as cover"
              value={coverId ?? ""}
              onChange={(e) => {
                void setCover(e.target.value === "" ? null : e.target.value);
              }}
            >
              <option value="">Use an image from the book…</option>
              {images.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.path}
                </option>
              ))}
            </select>
          )}
          {cover !== null && (
            <button type="button" onClick={() => void setCover(null)}>
              Remove cover
            </button>
          )}
        </div>
      </div>
      <p className="cover-picker-note">
        Cover changes apply immediately and are written on the next save.
      </p>
    </section>
  );
}
