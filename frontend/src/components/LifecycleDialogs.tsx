// Lifecycle-owned modals: the New Book dialog and the unsaved-changes
// sheet. Both are driven by the lifecycle controller (state/lifecycle.tsx);
// the sheet can stack over the New Book dialog (Create on a dirty book),
// and the shared <Modal> keeps keyboard handling on the topmost one.

import { useId } from "react";
import { useLifecycle } from "../state/lifecycle";
import { Modal } from "./Modal";
import { MetadataForm } from "./MetadataForm";

/**
 * HIG unsaved-changes sheet: Don't Save (destructive, set apart) · Cancel ·
 * Save (default). Return = Save, Esc = Cancel. The shared .modal-actions
 * recipe pushes the destructive button to the far left.
 */
export function UnsavedChangesSheet({
  title,
  onChoose,
}: {
  title: string;
  onChoose: (choice: "save" | "dont-save" | "cancel") => void;
}) {
  const bodyId = useId();
  return (
    <Modal
      role="alertdialog"
      className="sheet"
      title={`Do you want to save the changes made to “${title}”?`}
      describedBy={bodyId}
      onCancel={() => onChoose("cancel")}
      onEnter={() => onChoose("save")}
    >
      <p className="sheet-body" id={bodyId}>
        Your changes will be lost if you don’t save them.
      </p>
      <div className="modal-actions sheet-actions">
        <button
          type="button"
          data-variant="destructive"
          className="sheet-action-separate"
          onClick={() => onChoose("dont-save")}
        >
          Don’t Save
        </button>
        <button
          type="button"
          data-variant="secondary"
          onClick={() => onChoose("cancel")}
        >
          Cancel
        </button>
        <button
          type="button"
          data-variant="primary"
          data-autofocus
          onClick={() => onChoose("save")}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

export function LifecycleDialogs() {
  const {
    newBookDialog,
    cancelNew,
    submitNew,
    busy,
    guardTitle,
    resolveGuard,
  } = useLifecycle();
  return (
    <>
      {newBookDialog !== null && (
        <Modal title="New Book" onCancel={cancelNew}>
          <MetadataForm
            initial={null}
            submitLabel="Create book"
            submitting={busy}
            error={newBookDialog.error}
            note="Creates an unsaved book; you choose where to save it the first time you save."
            onCancel={cancelNew}
            onSubmit={submitNew}
          />
        </Modal>
      )}
      {guardTitle !== null && (
        <UnsavedChangesSheet title={guardTitle} onChoose={resolveGuard} />
      )}
    </>
  );
}
