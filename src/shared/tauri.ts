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

export interface NativeDropHandlers {
  /** Absolute paths dropped onto the window. */
  onDrop: (paths: string[]) => void;
  onEnter?: () => void;
  onLeave?: () => void;
}

/**
 * Listen for native OS drag-drop events (Tauri `dragDropEnabled: true`), which
 * expose real file-system paths — unlike HTML5 drops in the webview.
 *
 * Uses the low-level `tauri://drag-*` events via `@tauri-apps/api/event` rather
 * than `getCurrentWebview().onDragDropEvent`: the project pins TypeScript 4.4,
 * which can't parse the inline-type-import syntax in Tauri's `webview.d.ts`,
 * whereas `event.d.ts` is fine. Imported dynamically so `@tauri-apps/api` never
 * lands in the eager web bundle. Returns a combined unlisten function.
 */
export async function listenNativeDrop(
  handlers: NativeDropHandlers,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisteners = await Promise.all([
    listen('tauri://drag-enter', () => handlers.onEnter?.()),
    listen('tauri://drag-leave', () => handlers.onLeave?.()),
    listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
      handlers.onLeave?.();
      handlers.onDrop(event.payload.paths);
    }),
  ]);
  return () => unlisteners.forEach((unlisten) => unlisten());
}
