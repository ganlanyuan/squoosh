export interface DroppedFile {
  file: File;
  /** Path relative to the drop root (forward slashes). */
  rel: string;
}

export function isImageFile(name: string): boolean {
  return /\.(jpe?g|png|webp|avif|gif|bmp|tiff?|svg|qoi|jxl|wp2)$/i.test(name);
}

/** Recursively read a dropped file/directory entry into image files. */
function readEntry(entry: any, prefix: string): Promise<DroppedFile[]> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file: File) =>
          resolve(
            isImageFile(file.name) ? [{ file, rel: prefix + file.name }] : [],
          ),
        () => resolve([]),
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all: DroppedFile[] = [];
      const readBatch = () => {
        reader.readEntries(
          async (entries: any[]) => {
            if (entries.length === 0) {
              resolve(all);
              return;
            }
            for (const child of entries) {
              all.push(...(await readEntry(child, `${prefix}${entry.name}/`)));
            }
            readBatch();
          },
          () => resolve(all),
        );
      };
      readBatch();
    } else {
      resolve([]);
    }
  });
}

/**
 * Read image files (recursing into any dropped folders) from a drop event's
 * DataTransfer. `hadDirectory` indicates whether a folder was among the items,
 * which callers use to decide between single-image and batch handling.
 */
export async function filesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<{ files: DroppedFile[]; hadDirectory: boolean }> {
  // getAsEntry must be read synchronously while the event is being handled.
  const entries = Array.from(dataTransfer.items || [])
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean) as any[];

  let hadDirectory = false;
  let files: DroppedFile[] = [];

  if (entries.length > 0) {
    for (const entry of entries) {
      if (entry.isDirectory) hadDirectory = true;
      files = files.concat(await readEntry(entry, ''));
    }
  } else {
    files = Array.from(dataTransfer.files)
      .filter((file) => isImageFile(file.name))
      .map((file) => ({ file, rel: file.name }));
  }

  return { files, hadDirectory };
}
