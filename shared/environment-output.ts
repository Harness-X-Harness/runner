export const ENVIRONMENT_OUTPUT_BYTES = 64 * 1024;
export type OutputSnapshot = { revision: number; text: string; truncated: boolean };
export const emptyOutput = (): OutputSnapshot => ({ revision: 0, text: "", truncated: false });

/** A UTF-8 prefix, never a partial code point. Shared by runner and Worker bounds. */
export function boundedOutput(text: string, bytes: number): string {
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, bytes), { stream: true });
}
