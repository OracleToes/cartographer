// The application boundary always leaves the caller's render/key stack before a transitional synchronous domain
// operation touches durable state. Domain code remains authoritative while adapters migrate; this one yield keeps
// that compatibility seam out of interactive UI work.
export const yieldToUi = () => new Promise((resolve) => queueMicrotask(resolve));
