import * as React from "react";
import { useState } from "react";

/**
 * Test fixture for `scan` and `propose`: the classic boolean pile.
 * Four booleans = 16 representable combinations; about 4 are meaningful.
 */
export function SaveButton({ onSave }: { onSave: () => Promise<void> }) {
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setIsSaving(true);
    setHasError(false);
    setIsSaved(false);
    try {
      await onSave();
      setIsSaved(true);
    } catch (err) {
      setHasError(true);
      setError(String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <span
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <button type="button" disabled={isSaving} onClick={save}>
        {isSaving ? "Saving…" : isSaved ? "Saved" : hasError ? "Retry" : "Save"}
      </button>
      {showTooltip && <span role="tooltip">{hasError ? error : "Save your changes"}</span>}
    </span>
  );
}
