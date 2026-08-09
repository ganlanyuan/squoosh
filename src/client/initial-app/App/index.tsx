import type { FileDropEvent } from 'file-drop-element';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import type { SnackOptions } from 'shared/custom-els/snack-bar';

import { h, Component } from 'preact';

import { linkRef } from 'shared/prerendered-app/util';
import { isTauri, listenNativeDrop } from 'shared/tauri';
import { isImageFile } from 'client/lazy-app/drop';
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
    }
  }

  componentWillUnmount() {
    this.unlistenDrop?.();
  }

  private onNativeDragEnter = () => {
    // Batch owns its own drop highlight; only show the app overlay elsewhere.
    if (!this.state.isBatchOpen) this.setState({ dragging: true });
  };

  private onNativeDragLeave = () => {
    this.setState({ dragging: false });
  };

  private onNativeDrop = async (paths: string[]) => {
    if (this.state.isBatchOpen) return; // Batch handles its own drops.
    const imagePath = paths.find((p) => isImageFile(p));
    if (!imagePath) return;
    try {
      const { readFileBytes } = await import('client/lazy-app/tauri');
      const bytes = await readFileBytes(imagePath);
      const name = imagePath.split(/[\\/]/).pop() || 'image';
      this.onIntroPickFile(new File([bytes], name));
    } catch (err) {
      this.showSnack("Couldn't open the dropped file");
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
    this.setState({ isBatchOpen: false });
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
              <Batch onBack={this.closeBatch} showSnack={this.showSnack} />
            )
          ) : isEditorOpen ? (
            Compress && (
              <Compress file={file!} showSnack={this.showSnack} onBack={back} />
            )
          ) : (
            <Intro
              onFile={this.onIntroPickFile}
              onBatch={this.openBatch}
              showSnack={this.showSnack}
            />
          )}
          <snack-bar ref={linkRef(this, 'snackbar')} />
        </file-drop>
      </div>
    );
  }
}
