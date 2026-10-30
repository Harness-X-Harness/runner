export type T3Descriptor = { environmentId: string; serverVersion: string };

/** The public tunnel must reach the same native server as the local probe. */
export async function readT3Descriptor(origin: string, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch): Promise<T3Descriptor | null> {
  try {
    const response = await fetchImpl(new URL("/.well-known/t3/environment", origin), {
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" ||
        !("environmentId" in value) || typeof value.environmentId !== "string" || !value.environmentId.trim() ||
        !("serverVersion" in value) || typeof value.serverVersion !== "string" || !value.serverVersion.trim() ||
        !("capabilities" in value) || !value.capabilities || typeof value.capabilities !== "object" ||
        Array.isArray(value.capabilities) || !("repositoryIdentity" in value.capabilities) ||
        value.capabilities.repositoryIdentity !== true) return null;
    return { environmentId: value.environmentId, serverVersion: value.serverVersion };
  } catch { return null; }
}
