import * as React from "react";
import "./async-panel.css";

export type Deployment = { name: string; env: string; status: "live" | "building" | "failed" };

export type AsyncPanelProps = {
  isLoading?: boolean;
  error?: string | null;
  deployments?: Deployment[] | null;
};

/**
 * Test fixture: a presentational panel whose render is fully forced by
 * props — the shape statesheet mounts state-by-state. Styled with CSS
 * custom properties and a `.dark` override so the theme axis is real.
 */
export function AsyncPanel({ isLoading = false, error = null, deployments = null }: AsyncPanelProps) {
  return (
    <section className="ap-card" aria-busy={isLoading}>
      <header className="ap-head">
        <h2>Deployments</h2>
        <button type="button" className="ap-refresh" disabled={isLoading}>
          Refresh
        </button>
      </header>

      {isLoading && (
        <ul className="ap-list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="ap-row ap-skeleton">
              <span className="ap-bone ap-bone-name" />
              <span className="ap-bone ap-bone-env" />
              <span className="ap-bone ap-bone-badge" />
            </li>
          ))}
        </ul>
      )}

      {!isLoading && error && (
        <div className="ap-error" role="alert">
          <strong>Could not load deployments.</strong>
          <span>{error}</span>
          <button type="button">Retry</button>
        </div>
      )}

      {!isLoading && !error && deployments && deployments.length > 0 && (
        <ul className="ap-list">
          {deployments.map((d) => (
            <li key={d.name} className="ap-row">
              <span className="ap-name">{d.name}</span>
              <span className="ap-env">{d.env}</span>
              <span className={`ap-badge ap-badge-${d.status}`}>{d.status}</span>
            </li>
          ))}
        </ul>
      )}

      {!isLoading && !error && (!deployments || deployments.length === 0) && (
        <div className="ap-empty">
          <p>No deployments yet.</p>
          <button type="button">Create your first deployment</button>
        </div>
      )}
    </section>
  );
}
