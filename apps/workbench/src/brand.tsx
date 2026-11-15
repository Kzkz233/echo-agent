/** Shared application identity; character artwork remains owned by its role. */
export function BrandMark() {
  return <span className="brand-mark app-brand" role="img" aria-label="Echo">
    <span className="app-brand-symbol" aria-hidden="true" />
  </span>;
}

export function BrandWordmark() {
  return <span className="app-wordmark" role="img" aria-label="Echo" />;
}
