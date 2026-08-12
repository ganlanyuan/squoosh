import { invoke } from '@tauri-apps/api/core';
import { open, save, confirm } from '@tauri-apps/plugin-dialog';

const IMAGE_EXTS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'gif',
  'bmp',
  'tiff',
  'tif',
  'svg',
  'qoi',
  'jxl',
  'wp2',
];

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
export async function pickFolder(
  title: string,
  defaultPath?: string,
): Promise<string | null> {
  const result = await open({
    directory: true,
    multiple: false,
    title,
    defaultPath,
  });
  if (result == null) return null;
  return Array.isArray(result) ? result[0] : result;
}

/** Native image-file picker. Returns the chosen absolute path(s). */
export async function openImages(opts: {
  multiple: boolean;
  defaultPath?: string;
}): Promise<string[]> {
  const result = await open({
    directory: false,
    multiple: opts.multiple,
    defaultPath: opts.defaultPath,
    filters: [{ name: 'Images', extensions: IMAGE_EXTS }],
  });
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

/** Show a native "save file" dialog. Returns the chosen path, or null. */
export function saveFileDialog(defaultName: string): Promise<string | null> {
  return save({ defaultPath: defaultName });
}

/** List image files in a folder (optionally recursing). */
export function listImages(
  dir: string,
  recursive: boolean,
): Promise<ImageEntry[]> {
  return invoke<ImageEntry[]>('list_images', { dir, recursive });
}

export interface DropResult {
  /** Image files found among the dropped paths (folders expanded). */
  images: ImageEntry[];
  /** Absolute paths of the dropped entries that were folders. */
  folders: string[];
}

/** Classify natively-dropped paths (files and/or folders) into images + folders. */
export function collectDropped(
  paths: string[],
  recursive: boolean,
): Promise<DropResult> {
  return invoke<DropResult>('collect_dropped', { paths, recursive });
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

/** Open a URL in the OS default browser (rather than the app webview). */
export function openExternal(url: string): Promise<void> {
  return invoke('open_url', { url });
}

/** Native yes/no confirmation dialog. Resolves true if the user confirms. */
export function confirmDialog(message: string): Promise<boolean> {
  return confirm(message, { title: 'Squoosh', kind: 'warning' });
}

/** Quit the desktop app. */
export function closeApp(): Promise<void> {
  return invoke('close_app');
}

/** Download, install and relaunch into the available update. */
export function installUpdate(): Promise<void> {
  return invoke('install_update');
}

/** Show batch progress (0–100) on the taskbar/dock icon; null clears it. */
export function setTaskbarProgress(percent: number | null): Promise<void> {
  const progress =
    percent === null ? null : Math.round(Math.max(0, Math.min(100, percent)));
  return invoke('set_progress', { progress });
}
