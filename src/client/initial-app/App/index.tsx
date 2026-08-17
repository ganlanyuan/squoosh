import type { FileDropEvent } from 'file-drop-element';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import type { SnackOptions } from 'shared/custom-els/snack-bar';

import { h, Component } from 'preact';

import { linkRef } from 'shared/prerendered-app/util';
import { isTauri, listenNativeDrop, onUpdateAvailable } from 'shared/tauri';
import { getLastDir, setLastDir, dirOf } from 'shared/last-dir';
import * as style from './style.css';
import 'add-css:./style.css';
import 'file-drop-element';
import 'shared/custom-els/snack-bar';
import Intro from 'shared/prerendered-app/Intro';
import 'shared/custom-els/loading-spinner';

const ROUTE_EDITOR = '/editor';

const compressPromise = import('client/lazy-app/Compress');
const swBridgePromise = import('client/lazy-app/sw-bridge');

function back() {
  window.history.back();
}

interface Props {}

interface State {
  awaitingShareTarget: boolean;
  file?: File;
  isEditorOpen: Boolean;
  isBatchOpen: boolean;
  /** Native drag-drop hover state (Tauri only; drives the drop overlay). */
  dragging: boolean;
  /** Paths from a drop that opened Batch, handed to Batch on mount. */
  pendingBatchPaths?: string[];
  Compress?: typeof import('client/lazy-app/Compress').default;
  Batch?: typeof import('client/lazy-app/Batch').default;
}

export default class App extends Component<Props, State> {
  state: State = {
    awaitingShareTarget: new URL(location.href).searchParams.has(
      'share-target',
    ),
    isEditorOpen: false,
    isBatchOpen: false,
    dragging: false,
    file: undefined,
    Compress: undefined,
    Batch: undefined,
  };

  snackbar?: SnackBarElement;
  private unlistenDrop?: () => void;
  private unlistenUpdate?: () => void;
  /** The mounted Batch instance, for forwarding drops while it's open. */
  private batchInstance: {
    handleDroppedPaths(paths: string[]): void;
    isRunning(): boolean;
  } | null = null;

  constructor() {
    super();

    compressPromise
      .then((module) => {
        this.setState({ Compress: module.default });
      })
      .catch(() => {
        this.showSnack('Failed to load app');
      });

    swBridgePromise.then(async ({ offliner, getSharedImage }) => {
      offliner(this.showSnack);
      if (!this.state.awaitingShareTarget) return;
      const file = await getSharedImage();
      // Remove the ?share-target from the URL
      history.replaceState('', '', '/');
      this.openEditor();
      this.setState({ file, awaitingShareTarget: false });
    });

    // Since iOS 10, Apple tries to prevent disabling pinch-zoom. This is great in theory, but
    // really breaks things on Squoosh, as you can easily end up zooming the UI when you mean to
    // zoom the image. Once you've done this, it's really difficult to undo. Anyway, this seems to
    // prevent it.
    document.body.addEventListener('gesturestart', (event: any) => {
      event.preventDefault();
    });

    window.addEventListener('popstate', this.onPopState);
  }

  componentDidMount() {
    window.addEventListener('keydown', this.onKeyDown);
    // In the desktop app the window uses native OS drag-drop (dragDropEnabled),
    // so the HTML5 <file-drop> below never fires there — wire up native drops.
    if (isTauri()) {
      listenNativeDrop({
        onEnter: this.onNativeDragEnter,
        onLeave: this.onNativeDragLeave,
        onDrop: this.onNativeDrop,
      }).then((unlisten) => {
        this.unlistenDrop = unlisten;
      });
      onUpdateAvailable(this.onUpdateAvailable).then((unlisten) => {
        this.unlistenUpdate = unlisten;
      });
    }
  }

  componentWillUnmount() {
    window.removeEventListener('keydown', this.onKeyDown);
    this.unlistenDrop?.();
    this.unlistenUpdate?.();
  }

  // A newer signed release was found on launch — offer a 1-click update.
  private onUpdateAvailable = async (version: string) => {
    const action = await this.showSnack(`Squoosh ${version} is available`, {
      actions: ['Update & restart', 'Later'],
      timeout: 0,
    });
    if (action !== 'Update & restart') return;
    this.showSnack('Downloading update…', { timeout: 0 });
    try {
      const { installUpdate } = await import('client/lazy-app/tauri');
      await installUpdate(); // app relaunches on success; only returns on failure
    } catch (err) {
      this.showSnack('Update failed — try again later');
    }
  };

  /** Whether a batch is currently processing images. */
  private isBatchRunning(): boolean {
    return this.state.isBatchOpen && !!this.batchInstance?.isRunning();
  }

  private confirmIfRunning = async (message: string): Promise<boolean> => {
    if (!this.isBatchRunning()) return true;
    try {
      const { confirmDialog } = await import('client/lazy-app/tauri');
      return await confirmDialog(message);
    } catch {
      return true;
    }
  };

  private onKeyDown = (event: KeyboardEvent) => {
    // Ctrl/Cmd+W → quit the desktop app (confirm if a batch is processing).
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') {
      if (!isTauri()) return;
      event.preventDefault();
      this.requestCloseApp();
      return;
    }
    // Esc → leave the editor/batch and return to the intro screen.
    if (event.key === 'Escape') {
      if (this.state.isBatchOpen) {
        event.preventDefault();
        this.requestLeaveBatch();
      } else if (this.state.isEditorOpen) {
        event.preventDefault();
        back();
      }
    }
  };

  private requestCloseApp = async () => {
    if (
      !(await this.confirmIfRunning(
        'A batch is still processing. Quit anyway?',
      ))
    )
      return;
    const { closeApp } = await import('client/lazy-app/tauri');
    await closeApp();
  };

  private requestLeaveBatch = async () => {
    if (
      !(await this.confirmIfRunning(
        'A batch is still processing. Leave and stop it?',
      ))
    )
      return;
    this.closeBatch();
  };

  private onNativeDragEnter = () => {
    this.setState({ dragging: true });
  };

  private onNativeDragLeave = () => {
    this.setState({ dragging: false });
  };

  private onNativeDrop = async (paths: string[]) => {
    // Batch is open: forward the drop to it (App owns the only native listener,
    // so Batch never registers its own — that deadlocked WebView2 mid-drop).
    if (this.state.isBatchOpen) {
      this.batchInstance?.handleDroppedPaths(paths);
      return;
    }
    try {
      const { collectDropped, readFileBytes } = await import(
        'client/lazy-app/tauri'
      );
      const { images, folders } = await collectDropped(paths, true);
      // Multiple images or any folder → batch mode; a single image → edit it.
      if (folders.length > 0 || images.length > 1) {
        this.setState({ pendingBatchPaths: paths });
        this.openBatch();
        return;
      }
      const single = images[0];
      if (!single) return;
      const bytes = await readFileBytes(single.path);
      this.onIntroPickFile(new File([bytes], single.name));
    } catch (err) {
      this.showSnack("Couldn't open the dropped items");
    }
  };

  private onFileDrop = ({ files }: FileDropEvent) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    this.openEditor();
    this.setState({ file });
  };

  private onIntroPickFile = (file: File) => {
    this.openEditor();
    this.setState({ file });
  };

  // Native "select an image/folder" for the desktop app: remembers the folder
  // and reads the chosen file(s) from disk (the HTML file input can't do
  // either). Picking one image opens the editor; picking several routes to
  // batch mode. (Folders can't be chosen from a file dialog — they come in via
  // drag-drop or Batch's own "Add folder" button.)
  private onIntroOpenNative = async () => {
    try {
      const { openImages, readFileBytes } = await import(
        'client/lazy-app/tauri'
      );
      const paths = await openImages({
        multiple: true,
        defaultPath: getLastDir('source'),
      });
      if (paths.length === 0) return;
      setLastDir('source', dirOf(paths[0]));
      // Multiple images → batch mode; a single image → edit it.
      if (paths.length > 1) {
        this.setState({ pendingBatchPaths: paths });
        this.openBatch();
        return;
      }
      const path = paths[0];
      const bytes = await readFileBytes(path);
      const name = path.split(/[\\/]/).pop() || 'image';
      this.onIntroPickFile(new File([bytes], name));
    } catch (err) {
      this.showSnack("Couldn't open the image");
    }
  };

  // Native "select folder(s)" for the desktop app: picks one or more folders
  // of images and hands them to batch mode (folders are expanded recursively).
  private onIntroPickFolder = async () => {
    try {
      const { pickFolders } = await import('client/lazy-app/tauri');
      const dirs = await pickFolders(
        'Choose folder(s) of images',
        getLastDir('source'),
      );
      if (dirs.length === 0) return;
      setLastDir('source', dirs[0]);
      this.setState({ pendingBatchPaths: dirs });
      this.openBatch();
    } catch (err) {
      this.showSnack("Couldn't open the folder");
    }
  };

  // Open external links in the OS browser instead of navigating the webview.
  private onExternalLink = async (url: string) => {
    try {
      const { openExternal } = await import('client/lazy-app/tauri');
      await openExternal(url);
    } catch (err) {
      this.showSnack("Couldn't open the link");
    }
  };

  private openBatch = async () => {
    if (!this.state.Batch) {
      try {
        const module = await import('client/lazy-app/Batch');
        this.setState({ Batch: module.default });
      } catch (err) {
        this.showSnack('Failed to load batch mode');
        return;
      }
    }
    this.setState({ isBatchOpen: true });
  };

  private closeBatch = () => {
    this.setState({ isBatchOpen: false, pendingBatchPaths: undefined });
  };

  private showSnack = (
    message: string,
    options: SnackOptions = {},
  ): Promise<string> => {
    if (!this.snackbar) throw Error('Snackbar missing');
    return this.snackbar.showSnackbar(message, options);
  };

  private onPopState = () => {
    this.setState({ isEditorOpen: location.pathname === ROUTE_EDITOR });
  };

  private openEditor = () => {
    if (this.state.isEditorOpen) return;
    // Change path, but preserve query string.
    const editorURL = new URL(location.href);
    editorURL.pathname = ROUTE_EDITOR;
    history.pushState(null, '', editorURL.href);
    this.setState({ isEditorOpen: true });
  };

  render(
    {}: Props,
    {
      file,
      isEditorOpen,
      isBatchOpen,
      dragging,
      pendingBatchPaths,
      Compress,
      Batch,
      awaitingShareTarget,
    }: State,
  ) {
    const showSpinner =
      awaitingShareTarget ||
      (isEditorOpen && !Compress) ||
      (isBatchOpen && !Batch);

    return (
      <div class={style.app}>
        <file-drop
          onfiledrop={this.onFileDrop}
          class={`${style.drop}${dragging ? ' drop-valid' : ''}`}
        >
          {showSpinner ? (
            <loading-spinner class={style.appLoader} />
          ) : isBatchOpen ? (
            Batch && (
              <Batch
                ref={(inst) => (this.batchInstance = inst as any)}
                onBack={this.closeBatch}
                showSnack={this.showSnack}
                initialPaths={pendingBatchPaths}
              />
            )
          ) : isEditorOpen ? (
            Compress && (
              <Compress file={file!} showSnack={this.showSnack} onBack={back} />
            )
          ) : (
            <Intro
              onFile={this.onIntroPickFile}
              onPickImage={isTauri() ? this.onIntroOpenNative : undefined}
              onPickFolder={isTauri() ? this.onIntroPickFolder : undefined}
              onExternalLink={isTauri() ? this.onExternalLink : undefined}
              showSnack={this.showSnack}
            />
          )}
          <snack-bar ref={linkRef(this, 'snackbar')} />
        </file-drop>
      </div>
    );
  }
}
