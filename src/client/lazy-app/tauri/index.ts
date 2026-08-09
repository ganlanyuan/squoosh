import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

export interface ImageEntry {
  /** Absolute path on disk. */
  path: string;
  /** File name including extension. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Path relative to the selected folder (forward slashes). */
  rel: string;
}

/** Show a native folder picker. Returns the chosen path, or null if cancelled. */
export async function pickFolder(title: string): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title });
  if (result == null) return null;
  return Array.isArray(result) ? result[0] : result;
}

/** List image files in a folder (optionally recursing). */
export function listImages(
  dir: string,
  recursive: boolean,
): Promise<ImageEntry[]> {
  return invoke<ImageEntry[]>('list_images', { dir, recursive });
}

/** Read a file's bytes from disk. */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>('read_file', { path });
  return new Uint8Array(buffer);
}

/** Write bytes to disk, creating parent folders as needed. */
export function writeFileBytes(
  path: string,
  contents: Uint8Array,
): Promise<void> {
  return invoke('write_file', { path, contents });
}

/** Whether a path already exists. */
export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>('path_exists', { path });
}
