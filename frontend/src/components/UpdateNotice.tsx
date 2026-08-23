import { useEffect, useRef, useState } from "react";
import {
  checkForUpdateAfterLaunch,
  openLatestRelease,
  type UpdateState,
} from "../lib/updater";

/** Non-modal update discovery notice; all other states are visually silent. */
export function UpdateNotice() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const releaseOpened = useRef(false);

  useEffect(() => {
    let active = true;
    setState({ status: "checking" });
    void checkForUpdateAfterLaunch().then((result) => {
      if (active) setState(result);
    });
    return () => {
      active = false;
    };
  }, []);

  if (state.status !== "available" || dismissed) return null;

  const viewRelease = () => {
    if (releaseOpened.current) return;
    releaseOpened.current = true;
    void openLatestRelease();
  };

  return (
    <aside
      className="update-notice"
      aria-label="Update available"
      aria-live="polite"
    >
      <span>
        epubzilla {state.version} is available. Download and installation are
        manual; this app will stay open.
      </span>
      <button type="button" onClick={viewRelease}>
        View release
      </button>
      <button
        className="update-dismiss"
        type="button"
        aria-label="Dismiss update notice"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </aside>
  );
}
