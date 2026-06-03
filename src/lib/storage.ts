/** Synchronous localStorage read for atom defaults (client only). */
export const readStoredJson = <T>(key: string, fallback: T): T => {
  if (typeof window === "undefined") return fallback;

  try {
    const item = window.localStorage.getItem(key);
    if (item === null) return fallback;
    return JSON.parse(item) as T;
  } catch {
    return fallback;
  }
};
