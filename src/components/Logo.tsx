/** The RD+ mark: a white R, a blue D, and a red cross. */
export function Logo() {
  return (
    <div className="brand" aria-label="RimDoc+" title="RimDoc+">
      <span className="r">R</span>
      <span className="d">D</span>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="6.2" y="0.8" width="3.6" height="14.4" rx="1.1" fill="#e5484d" />
        <rect x="0.8" y="6.2" width="14.4" height="3.6" rx="1.1" fill="#e5484d" />
      </svg>
    </div>
  );
}
