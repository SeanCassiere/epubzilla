// Reusable metadata form (M2.2): shared by the new-book wizard and the
// edit-metadata action. Pure UI — no IPC in here; the parent decides what
// happens with the submitted Metadata (create_book vs update_metadata).

import { useState, type FormEvent } from "react";
import type { Metadata } from "@bindings/Metadata";

interface MetadataFormProps {
  /**
   * Existing metadata to pre-fill (edit mode); null means a new book.
   * In edit mode `identifier`, `modified`, and `cover_resource` are carried
   * through untouched — an existing book must NEVER be submitted with an
   * empty identifier (the core would accept it and validation would then
   * flag the book).
   */
  initial: Metadata | null;
  submitLabel: string;
  onSubmit: (metadata: Metadata) => void;
  onCancel: () => void;
}

/** Trimmed value, or null when empty (optional dc: fields). */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function MetadataForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: MetadataFormProps) {
  const [title, setTitle] = useState(initial?.title ?? "");
  // Always at least one author row so the list is editable from the start.
  const [authors, setAuthors] = useState<string[]>(
    initial !== null && initial.authors.length > 0 ? initial.authors : [""],
  );
  const [language, setLanguage] = useState(initial?.language ?? "en");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [publisher, setPublisher] = useState(initial?.publisher ?? "");
  const [titleError, setTitleError] = useState(false);

  const setAuthor = (index: number, value: string) => {
    setAuthors((prev) => prev.map((a, i) => (i === index ? value : a)));
  };
  const addAuthor = () => setAuthors((prev) => [...prev, ""]);
  const removeAuthor = (index: number) =>
    setAuthors((prev) =>
      prev.length === 1 ? [""] : prev.filter((_, i) => i !== index),
    );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (trimmedTitle === "") {
      setTitleError(true);
      return;
    }
    onSubmit({
      title: trimmedTitle,
      authors: authors.map((a) => a.trim()).filter((a) => a !== ""),
      language: language.trim() === "" ? "en" : language.trim(),
      // New book: empty string — the core generates a urn:uuid identifier.
      identifier: initial?.identifier ?? "",
      modified: initial?.modified ?? null,
      description: orNull(description),
      publisher: orNull(publisher),
      cover_resource: initial?.cover_resource ?? null,
    });
  };

  return (
    <form className="metadata-form" onSubmit={handleSubmit} noValidate>
      <label className="metadata-field">
        <span className="metadata-label">Title</span>
        <input
          type="text"
          name="title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (e.target.value.trim() !== "") setTitleError(false);
          }}
          aria-invalid={titleError}
          autoFocus
        />
        {titleError && (
          <span className="metadata-field-error" role="alert">
            Title is required.
          </span>
        )}
      </label>

      <fieldset className="metadata-authors">
        <legend className="metadata-label">Authors</legend>
        {authors.map((author, index) => (
          <div className="metadata-author-row" key={index}>
            <input
              type="text"
              aria-label={`Author ${index + 1}`}
              value={author}
              onChange={(e) => setAuthor(index, e.target.value)}
            />
            <button
              type="button"
              aria-label={`Remove author ${index + 1}`}
              onClick={() => removeAuthor(index)}
            >
              −
            </button>
          </div>
        ))}
        <button type="button" onClick={addAuthor}>
          Add author
        </button>
      </fieldset>

      <label className="metadata-field">
        <span className="metadata-label">Language</span>
        <input
          type="text"
          name="language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        />
      </label>

      <div className="metadata-field">
        <span className="metadata-label">Identifier</span>
        {initial !== null ? (
          <input
            type="text"
            name="identifier"
            value={initial.identifier}
            readOnly
            aria-label="Identifier (read-only)"
          />
        ) : (
          <span className="metadata-generated">(generated on create)</span>
        )}
      </div>

      <details className="metadata-extras">
        <summary>More fields</summary>
        <label className="metadata-field">
          <span className="metadata-label">Description</span>
          <textarea
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </label>
        <label className="metadata-field">
          <span className="metadata-label">Publisher</span>
          <input
            type="text"
            name="publisher"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
          />
        </label>
      </details>

      <div className="metadata-form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit">{submitLabel}</button>
      </div>
    </form>
  );
}
