import { h, Component, Fragment } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import WorkerBridge from '../worker-bridge';
import { processImageFile, BatchSettings } from '../pipeline';
import {
  encoderMap,
  EncoderType,
  EncoderState,
  defaultPreprocessorState,
  defaultProcessorState,
} from '../feature-meta';
import { Options as QuantizeOptionsComponent } from 'features/processors/quantize/client';
import {
  pickFolder,
  openImages,
  listImages,
  collectDropped,
  readFileBytes,
  writeFileBytes,
  pathExists,
  setTaskbarProgress,
} from '../tauri';
import { isTauri } from 'shared/tauri';
import { getLastDir, setLastDir, dirOf } from 'shared/last-dir';
import prettyBytes from '../Compress/Results/pretty-bytes';
import type SnackBarElement from 'shared/custom-els/snack-bar';

type ItemStatus = 'queued' | 'processing' | 'done' | 'skipped' | 'error';

interface BatchItem {
  id: string;
  name: string;
  size: number;
  /** Relative path (forward slashes) used for preserving folder structure. */
  rel: string;
  /** Present when added via the file picker. */
  file?: File;
  /** Present when added from a folder; read from disk on demand. */
  path?: string;
  status: ItemStatus;
  outputSize?: number;
  error?: string;
}

interface Props {
  onBack: () => void;
  showSnack: SnackBarElement['showSnackbar'];
  /** Paths from the drop that opened Batch; queued on mount. */
  initialPaths?: string[];
}

interface State {
  items: BatchItem[];
  encoderType: EncoderType;
  encoderOptions: any;
  resizePercent: number;
  quantizeEnabled: boolean;
  quantizeOptions: typeof defaultProcessorState.quantize;
  outputFolder: string | null;
  recursive: boolean;
  preserveStructure: boolean;
  skipExisting: boolean;
  suffix: string;
  running: boolean;
  doneCount: number;
  /** Snapshot of inputs+settings taken when a batch finishes; null unless in a
   * completed state. While it still matches the current inputs, Start stays
   * disabled to prevent an accidental re-run overwriting the outputs. */
  completedSignature: string | null;
}

const MAX_WORKERS = Math.min(4, navigator.hardwareConcurrency || 4);

function prettySize(bytes: number): string {
  const { value, unit } = prettyBytes(bytes);
  return `${value} ${unit}`;
}

let nextId = 0;

export default class Batch extends Component<Props, State> {
  private fileInput?: HTMLInputElement;
  private abortController = new AbortController();
  /** settingsSignature() from the last run; used to decide whole vs partial re-run. */
  private lastRunSettings: string | null = null;

  state: State = {
    items: [],
    encoderType: 'mozJPEG',
    encoderOptions: encoderMap.mozJPEG.meta.defaultOptions,
    resizePercent: 100,
    quantizeEnabled: false,
    quantizeOptions: defaultProcessorState.quantize,
    outputFolder: null,
    recursive: true,
    preserveStructure: true,
    skipExisting: false,
    suffix: '',
    running: false,
    doneCount: 0,
    completedSignature: null,
  };

  componentDidMount() {
    // Native drops are received by App's single listener and forwarded via
    // handleDroppedPaths — Batch must NOT register its own drag-drop listener
    // (doing so mid-drop froze WebView2). Just queue the drop that opened us.
    if (isTauri() && this.props.initialPaths?.length) {
      this.onNativeDrop(this.props.initialPaths);
    }
  }

  componentDidUpdate(_prevProps: Props, prevState: State) {
    // Mirror batch progress on the taskbar (Windows) / dock (macOS) icon.
    if (!isTauri()) return;
    const total = this.state.items.length;
    const { running, doneCount } = this.state;
    const changed =
      prevState.running !== running ||
      prevState.doneCount !== doneCount ||
      prevState.items.length !== total;
    if (!changed) return;
    if (running) {
      setTaskbarProgress(total ? (doneCount / total) * 100 : 0);
    } else if (prevState.running) {
      setTaskbarProgress(null); // just finished or cancelled → clear
    }
  }

  /** Entry point for native drops, called by App while Batch is open. */
  handleDroppedPaths = (paths: string[]) => {
    this.onNativeDrop(paths);
  };

  /** Whether a batch is currently processing (App checks before closing). */
  isRunning = () => this.state.running;

  private onNativeDrop = async (paths: string[]) => {
    if (this.state.running) return;
    try {
      const { images, folders } = await collectDropped(
        paths,
        this.state.recursive,
      );
      const items: BatchItem[] = images.map((entry) => ({
        id: `n${nextId++}`,
        name: entry.name,
        size: entry.size,
        rel: entry.rel,
        path: entry.path,
        status: 'queued',
      }));
      // Auto-fill the output folder from a dropped folder, only if unset.
      if (folders.length > 0 && !this.state.outputFolder) {
        this.setState({ outputFolder: folders[0] });
      }
      if (items.length) this.addItems(items);
      else this.props.showSnack('No images in the dropped items');
    } catch (err) {
      this.props.showSnack(`Couldn't read dropped items: ${err}`);
    }
  };

  private settingsSignature(): string {
    const {
      encoderType,
      encoderOptions,
      resizePercent,
      quantizeEnabled,
      quantizeOptions,
      outputFolder,
      suffix,
      preserveStructure,
      recursive,
      skipExisting,
    } = this.state;
    return JSON.stringify({
      encoderType,
      encoderOptions,
      resizePercent,
      quantizeEnabled,
      quantizeOptions,
      outputFolder,
      suffix,
      preserveStructure,
      recursive,
      skipExisting,
    });
  }

  private currentSignature(): string {
    return JSON.stringify({
      ids: this.state.items.map((it) => it.id),
      settings: this.settingsSignature(),
    });
  }

  private onAddFilesClick = async () => {
    // In Tauri use the native picker (remembers the folder, gives real paths).
    if (isTauri()) {
      try {
        const paths = await openImages({
          multiple: true,
          defaultPath: getLastDir('source'),
        });
        if (paths.length === 0) return;
        setLastDir('source', dirOf(paths[0]));
        const { images } = await collectDropped(paths, this.state.recursive);
        const items: BatchItem[] = images.map((entry) => ({
          id: `f${nextId++}`,
          name: entry.name,
          size: entry.size,
          rel: entry.rel,
          path: entry.path,
          status: 'queued',
        }));
        if (items.length) this.addItems(items);
        else this.props.showSnack('No images selected');
      } catch (err) {
        this.props.showSnack(`Couldn't add files: ${err}`);
      }
      return;
    }
    this.fileInput!.click();
  };

  private onFilesChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;
    const items: BatchItem[] = Array.from(input.files).map((file) => ({
      id: `f${nextId++}`,
      name: file.name,
      size: file.size,
      rel: file.name,
      file,
      status: 'queued',
    }));
    input.value = '';
    this.addItems(items);
  };

  private isImageFile(name: string): boolean {
    return /\.(jpe?g|png|webp|avif|gif|bmp|tiff?|svg|qoi|jxl|wp2)$/i.test(name);
  }

  private itemFromFile(file: File, rel: string): BatchItem {
    return {
      id: `x${nextId++}`,
      name: file.name,
      size: file.size,
      rel,
      file,
      status: 'queued',
    };
  }

  /** Recursively read a dropped file/directory entry into batch items. */
  private readEntry(entry: any, prefix: string): Promise<BatchItem[]> {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(
          (file: File) =>
            resolve(
              this.isImageFile(file.name)
                ? [this.itemFromFile(file, prefix + file.name)]
                : [],
            ),
          () => resolve([]),
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all: BatchItem[] = [];
        const readBatch = () => {
          reader.readEntries(
            async (entries: any[]) => {
              if (entries.length === 0) {
                resolve(all);
                return;
              }
              for (const child of entries) {
                all.push(
                  ...(await this.readEntry(child, `${prefix}${entry.name}/`)),
                );
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

  private onDragOver = (event: DragEvent) => {
    event.preventDefault();
  };

  private onDrop = async (event: DragEvent) => {
    event.preventDefault();
    if (this.state.running || !event.dataTransfer) return;

    const entries = Array.from(event.dataTransfer.items || [])
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);

    let items: BatchItem[] = [];
    if (entries.length > 0) {
      for (const entry of entries) {
        items = items.concat(await this.readEntry(entry, ''));
      }
    } else {
      items = Array.from(event.dataTransfer.files)
        .filter((file) => this.isImageFile(file.name))
        .map((file) => this.itemFromFile(file, file.name));
    }

    if (items.length) this.addItems(items);
    else this.props.showSnack('No images in the dropped items');
  };

  private onAddFolderClick = async () => {
    try {
      const dir = await pickFolder(
        'Choose a folder of images',
        getLastDir('source'),
      );
      if (!dir) return;
      setLastDir('source', dir);
      const entries = await listImages(dir, this.state.recursive);
      const items: BatchItem[] = entries.map((entry) => ({
        id: `d${nextId++}`,
        name: entry.name,
        size: entry.size,
        rel: entry.rel,
        path: entry.path,
        status: 'queued',
      }));
      if (items.length === 0) {
        this.props.showSnack('No images found in that folder');
        return;
      }
      // Auto-fill the output folder from the added folder, only if unset.
      if (!this.state.outputFolder) this.setState({ outputFolder: dir });
      this.addItems(items);
    } catch (err) {
      this.props.showSnack(`Couldn't read folder: ${err}`);
    }
  };

  private onChooseOutputClick = async () => {
    try {
      const dir = await pickFolder(
        'Choose an output folder',
        getLastDir('output'),
      );
      if (dir) {
        setLastDir('output', dir);
        this.setState({ outputFolder: dir });
      }
    } catch (err) {
      this.props.showSnack(`Couldn't choose folder: ${err}`);
    }
  };

  private addItems(newItems: BatchItem[]) {
    this.setState((state) => ({ items: [...state.items, ...newItems] }));
  }

  private onClearClick = () => {
    if (this.state.running) return;
    this.lastRunSettings = null;
    this.setState({ items: [], doneCount: 0, completedSignature: null });
  };

  private onEncoderTypeChange = (event: Event) => {
    const type = (event.target as HTMLSelectElement).value as EncoderType;
    this.setState({
      encoderType: type,
      encoderOptions: encoderMap[type].meta.defaultOptions,
    });
  };

  private onEncoderOptionsChange = (options: any) => {
    this.setState({ encoderOptions: options });
  };

  private buildSettings(): BatchSettings {
    const { encoderType, encoderOptions, resizePercent, quantizeEnabled } =
      this.state;
    return {
      preprocessorState: defaultPreprocessorState,
      processorState: {
        resize: { ...defaultProcessorState.resize, enabled: false },
        quantize: { ...this.state.quantizeOptions, enabled: quantizeEnabled },
      },
      encoderState: {
        type: encoderType,
        options: encoderOptions,
      } as EncoderState,
      resizePercent,
    };
  }

  private outputPathFor(item: BatchItem): string | null {
    const { outputFolder, preserveStructure, suffix, encoderType } = this.state;
    const ext = encoderMap[encoderType].meta.extension;
    const base = item.name.replace(/\.[^.]*$/, '');
    if (outputFolder) {
      const dir = preserveStructure ? item.rel.replace(/[^/]*$/, '') : '';
      return `${outputFolder}/${dir}${base}${suffix}.${ext}`.replace(
        /\/+/g,
        '/',
      );
    }
    // No output folder → write beside the original, using the source's own
    // folder. Needs an absolute source path (drag/folder items have one).
    if (item.path) {
      const srcDir = item.path.replace(/[^/\\]+$/, ''); // keep trailing separator
      return `${srcDir}${base}${suffix}.${ext}`;
    }
    return null;
  }

  private async fileFor(item: BatchItem): Promise<File> {
    if (item.file) return item.file;
    const bytes = await readFileBytes(item.path!);
    return new File([bytes], item.name);
  }

  private setItem(id: string, patch: Partial<BatchItem>) {
    this.setState((state) => ({
      items: state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    }));
  }

  /** Whether every queued item can be written somewhere. */
  private canWrite(): boolean {
    const { outputFolder, items } = this.state;
    if (outputFolder) return true;
    // No output folder → each item must have a source path to write beside.
    return items.length > 0 && items.every((it) => !!it.path);
  }

  private onStartClick = async () => {
    if (this.state.running) return;
    if (!this.canWrite()) {
      this.props.showSnack(
        'Choose an output folder, or add images from folders to save beside the originals',
      );
      return;
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const settings = this.buildSettings();

    // Settings change → redo the whole batch; otherwise only process the newly
    // added (still-queued) items and leave finished ones as they are.
    const settingsSig = this.settingsSignature();
    const redoAll =
      this.lastRunSettings !== null && this.lastRunSettings !== settingsSig;
    this.lastRunSettings = settingsSig;

    // Decide the work up front so we don't depend on setState having flushed.
    const toProcess = redoAll
      ? this.state.items
      : this.state.items.filter((it) => it.status === 'queued');

    this.setState((state) => ({
      running: true,
      doneCount: state.items.length - toProcess.length,
      items: redoAll
        ? state.items.map((it) => ({
            ...it,
            status: 'queued',
            outputSize: undefined,
            error: undefined,
          }))
        : state.items,
    }));

    const bridges = Array.from(
      { length: MAX_WORKERS },
      () => new WorkerBridge(),
    );
    let cursor = 0;

    const runOne = async (bridge: WorkerBridge): Promise<void> => {
      while (!signal.aborted) {
        const index = cursor++;
        const item = toProcess[index];
        if (!item) return;

        this.setItem(item.id, { status: 'processing' });
        try {
          const outPath = this.outputPathFor(item);
          if (!outPath) {
            this.setItem(item.id, {
              status: 'error',
              error: 'No output folder set',
            });
            this.setState((s) => ({ doneCount: s.doneCount + 1 }));
            continue;
          }
          if (this.state.skipExisting && (await pathExists(outPath))) {
            this.setItem(item.id, { status: 'skipped' });
            this.setState((s) => ({ doneCount: s.doneCount + 1 }));
            continue;
          }

          const file = await this.fileFor(item);
          const out = await processImageFile(signal, file, settings, bridge);
          const bytes = new Uint8Array(await out.arrayBuffer());
          await writeFileBytes(outPath, bytes);

          this.setItem(item.id, { status: 'done', outputSize: out.size });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return;
          this.setItem(item.id, { status: 'error', error: String(err) });
        }
        this.setState((s) => ({ doneCount: s.doneCount + 1 }));
      }
    };

    try {
      await Promise.all(bridges.map((bridge) => runOne(bridge)));
    } finally {
      if (!signal.aborted) {
        this.props.showSnack('Batch complete', { timeout: 4000 });
        this.setState({
          running: false,
          completedSignature: this.currentSignature(),
        });
      } else {
        this.setState({ running: false });
      }
    }
  };

  private onCancelClick = () => {
    this.abortController.abort();
    this.setState((state) => ({
      running: false,
      items: state.items.map((it) =>
        it.status === 'processing' ? { ...it, status: 'queued' } : it,
      ),
    }));
  };

  componentWillUnmount() {
    this.abortController.abort();
    // Don't leave a stuck progress overlay if we leave mid-run.
    if (isTauri()) setTaskbarProgress(null);
  }

  render(
    { onBack }: Props,
    {
      items,
      encoderType,
      encoderOptions,
      resizePercent,
      quantizeEnabled,
      quantizeOptions,
      outputFolder,
      recursive,
      preserveStructure,
      skipExisting,
      suffix,
      running,
      doneCount,
      completedSignature,
    }: State,
  ) {
    const EncoderOptions = (encoderMap[encoderType] as any).Options;
    const total = items.length;
    const justCompleted =
      completedSignature !== null &&
      completedSignature === this.currentSignature();
    const savedTotal = items.reduce(
      (sum, it) =>
        it.outputSize != null ? sum + (it.size - it.outputSize) : sum,
      0,
    );

    return (
      <div
        class={style.batch}
        onDragOver={this.onDragOver}
        onDrop={this.onDrop}
      >
        <input
          class={style.hide}
          ref={(el) => (this.fileInput = el as HTMLInputElement)}
          type="file"
          multiple
          accept="image/*"
          onChange={this.onFilesChange}
        />

        <div class={style.main}>
          <header class={style.header}>
            <button class={style.back} onClick={onBack}>
              ← Back
            </button>
            <h1 class={style.title}>Batch process</h1>
          </header>

          <div class={style.toolbar}>
            <button
              class={style.button}
              onClick={this.onAddFilesClick}
              disabled={running}
            >
              Add files
            </button>
            <button
              class={style.button}
              onClick={this.onAddFolderClick}
              disabled={running}
            >
              Add folder
            </button>
            <button
              class={style.button}
              onClick={this.onClearClick}
              disabled={running || total === 0}
            >
              Clear
            </button>
          </div>

          {total === 0 ? (
            <p class={style.empty}>
              Add files or a folder — or drag &amp; drop images here.
            </p>
          ) : (
            <ul class={style.queue}>
              {items.map((item) => (
                <li class={style.item} key={item.id}>
                  <span class={style.itemName} title={item.path || item.rel}>
                    {item.path || item.rel}
                  </span>
                  <span class={style.itemSize}>{prettySize(item.size)}</span>
                  <span class={`${style.status} ${style[item.status]}`}>
                    {item.status === 'done' && item.outputSize != null ? (
                      <Fragment>
                        {prettySize(item.outputSize)}
                        {' · '}
                        {item.size > 0
                          ? `${Math.round(
                              (1 - item.outputSize / item.size) * 100,
                            )}% smaller`
                          : ''}
                      </Fragment>
                    ) : item.status === 'error' ? (
                      <span title={item.error}>error</span>
                    ) : (
                      item.status
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div class={style.settings}>
          <h2 class={style.settingsTitle}>Output</h2>
          <button class={style.button} onClick={this.onChooseOutputClick}>
            Choose output folder…
          </button>
          <p class={style.path} title={outputFolder || ''}>
            {outputFolder || 'No folder — saved next to each original'}
          </p>

          <label class={style.field}>
            Filename suffix
            <input
              type="text"
              value={suffix}
              placeholder="e.g. -min"
              onInput={(e) =>
                this.setState({ suffix: (e.target as HTMLInputElement).value })
              }
            />
          </label>
          <label class={style.check}>
            <input
              type="checkbox"
              checked={preserveStructure}
              onChange={(e) =>
                this.setState({
                  preserveStructure: (e.target as HTMLInputElement).checked,
                })
              }
            />
            Preserve subfolders
          </label>
          <label class={style.check}>
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) =>
                this.setState({
                  recursive: (e.target as HTMLInputElement).checked,
                })
              }
            />
            Include subfolders when adding a folder
          </label>
          <label class={style.check}>
            <input
              type="checkbox"
              checked={skipExisting}
              onChange={(e) =>
                this.setState({
                  skipExisting: (e.target as HTMLInputElement).checked,
                })
              }
            />
            Skip files that already exist
          </label>

          <h2 class={style.settingsTitle}>Compress</h2>
          <label class={style.field}>
            Format
            <select value={encoderType} onChange={this.onEncoderTypeChange}>
              {(Object.keys(encoderMap) as EncoderType[]).map((type) => (
                <option value={type} key={type}>
                  {encoderMap[type].meta.label}
                </option>
              ))}
            </select>
          </label>

          <EncoderOptions
            options={encoderOptions}
            onChange={this.onEncoderOptionsChange}
          />

          <label class={style.field}>
            Resize
            <span class={style.inline}>
              <input
                type="number"
                min="1"
                max="100"
                value={resizePercent}
                onInput={(e) =>
                  this.setState({
                    resizePercent:
                      Number((e.target as HTMLInputElement).value) || 100,
                  })
                }
              />
              %
            </span>
          </label>

          <label class={style.check}>
            <input
              type="checkbox"
              checked={quantizeEnabled}
              onChange={(e) =>
                this.setState({
                  quantizeEnabled: (e.target as HTMLInputElement).checked,
                })
              }
            />
            Reduce palette
          </label>
          {quantizeEnabled && (
            <QuantizeOptionsComponent
              options={quantizeOptions}
              onChange={(options: any) =>
                this.setState({ quantizeOptions: options })
              }
            />
          )}

          <div class={style.run}>
            {running ? (
              <button
                class={`${style.button} ${style.primary}`}
                onClick={this.onCancelClick}
              >
                Cancel
              </button>
            ) : (
              <button
                class={`${style.button} ${style.primary}`}
                onClick={this.onStartClick}
                disabled={total === 0 || !this.canWrite() || justCompleted}
              >
                Start
              </button>
            )}
            {(running || doneCount > 0) && (
              <div class={style.progress}>
                <div
                  class={style.progressBar}
                  style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }}
                />
                <span class={style.progressText}>
                  {doneCount} / {total}
                  {savedTotal > 0 ? ` · saved ${prettySize(savedTotal)}` : ''}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
}
