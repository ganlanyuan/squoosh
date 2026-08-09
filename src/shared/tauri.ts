/**
 * Are we running inside the native desktop app (Tauri) rather than a browser?
 */
export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window ||
      '__TAURI__' in window ||
      (window as any).isTauri === true)
  );
}
