/** Estimated tokens from text length; the single estimator (4 bytes/token). */
export const estimateTokens = (text: string): number => (text.length === 0 ? 0 : Math.ceil(text.length / 4));

/** Estimated tokens of a JSON-serialized value; non-serializable values cost 0. */
export const estimateSerialized = (value: unknown): number => {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : estimateTokens(json);
};
