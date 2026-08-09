/**
 * Remembers the directory last used for native file/folder dialogs so each
 * dialog reopens where the user left off. Persisted in localStorage. Buckets
 * keep source pickers (add files / add folder / select image) separate from the
 * output folder.
 */
export type DirBucket = 'source' | 'output';

const keyFor = (bucket: DirBucket) => `squoosh:lastDir:${bucket}`;

export function getLastDir(bucket: DirBucket): string | undefined {
  try {
    return localStorage.getItem(keyFor(bucket)) || undefined;
  } catch {
    return undefined;
  }
}

export function setLastDir(bucket: DirBucket, path: string): void {
  try {
    localStorage.setItem(keyFor(bucket), path);
  } catch {
    // Ignore storage errors (private mode, disabled, etc.).
  }
}

/** The directory portion of a native path (handles both `/` and `\`). */
export function dirOf(path: string): string {
  return path.replace(/[/\\][^/\\]*$/, '') || path;
}
