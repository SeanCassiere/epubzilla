// Open-modal registry. The shared <Modal> registers itself here so that
// (1) only the topmost modal reacts to Esc / Return / Tab, and (2) the
// lifecycle controller can refuse background entry points (⌘O, ⌘N, a
// drop, Finder) while any modal decision is on screen, instead of opening
// a second dialog behind it.

const stack: number[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function notify(): void {
  for (const listener of listeners) listener();
}

/** Register a newly opened modal; returns its id. */
export function pushModal(): number {
  const id = nextId;
  nextId += 1;
  stack.push(id);
  notify();
  return id;
}

/** Unregister a modal (on close/unmount). */
export function popModal(id: number): void {
  const index = stack.indexOf(id);
  if (index === -1) return;
  stack.splice(index, 1);
  notify();
}

/** Whether `id` is the topmost open modal. */
export function isTopModal(id: number): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** Whether any modal is open. */
export function anyModalOpen(): boolean {
  return stack.length > 0;
}

/** Subscribe to open/close changes (useSyncExternalStore-compatible). */
export function subscribeModals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
