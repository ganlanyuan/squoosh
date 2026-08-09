import { h, Component } from 'preact';

import { linkRef } from 'shared/prerendered-app/util';
import '../../custom-els/loading-spinner';
import logo from 'url:./imgs/logo.svg';
import largePhoto from 'url:./imgs/demos/demo-large-photo.jpg';
import artwork from 'url:./imgs/demos/demo-artwork.jpg';
import deviceScreen from 'url:./imgs/demos/demo-device-screen.png';
import largePhotoIcon from 'url:./imgs/demos/icon-demo-large-photo.jpg';
import artworkIcon from 'url:./imgs/demos/icon-demo-artwork.jpg';
import deviceScreenIcon from 'url:./imgs/demos/icon-demo-device-screen.jpg';
import logoIcon from 'url:./imgs/demos/icon-demo-logo.png';
import * as style from './style.css';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import 'shared/custom-els/snack-bar';
import { isTauri } from 'shared/tauri';

const demos = [
  {
    description: 'Large photo',
    size: '2.8MB',
    filename: 'photo.jpg',
    url: largePhoto,
    iconUrl: largePhotoIcon,
  },
  {
    description: 'Artwork',
    size: '2.9MB',
    filename: 'art.jpg',
    url: artwork,
    iconUrl: artworkIcon,
  },
  {
    description: 'Device screen',
    size: '1.6MB',
    filename: 'pixel3.png',
    url: deviceScreen,
    iconUrl: deviceScreenIcon,
  },
  {
    description: 'SVG icon',
    size: '13KB',
    filename: 'squoosh.svg',
    url: logo,
    iconUrl: logoIcon,
  },
] as const;

interface Props {
  onFile?: (file: File) => void;
  onBatch?: () => void;
  /** When set (desktop app), used instead of the HTML file input. */
  onPickImage?: () => void;
  showSnack?: SnackBarElement['showSnackbar'];
}
interface State {
  fetchingDemoIndex?: number;
}

export default class Intro extends Component<Props, State> {
  state: State = {};
  private fileInput?: HTMLInputElement;

  private onFileChange = (event: Event): void => {
    const fileInput = event.target as HTMLInputElement;
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    this.fileInput!.value = '';
    this.props.onFile!(file);
  };

  private onOpenClick = () => {
    if (this.props.onPickImage) {
      this.props.onPickImage();
      return;
    }
    this.fileInput!.click();
  };

  private onDemoClick = async (index: number) => {
    try {
      this.setState({ fetchingDemoIndex: index });
      const demo = demos[index];
      const blob = await fetch(demo.url).then((r) => r.blob());
      const file = new File([blob], demo.filename, { type: blob.type });
      this.props.onFile!(file);
    } catch (err) {
      this.setState({ fetchingDemoIndex: undefined });
      this.props.showSnack!("Couldn't fetch demo image");
    }
  };

  render({}: Props, { fetchingDemoIndex }: State) {
    return (
      <div class={style.intro}>
        <input
          class={style.hide}
          ref={linkRef(this, 'fileInput')}
          type="file"
          onChange={this.onFileChange}
        />
        <div class={style.main}>
          <img
            class={style.logo}
            src={logo}
            alt="Squoosh"
            width="360"
            height="360"
          />
          <h1 class={style.title}>
            Drag &amp; drop or{' '}
            <button class={style.selectBtn} onClick={this.onOpenClick}>
              select an image
            </button>
          </h1>
          {isTauri() && this.props.onBatch && (
            <button class={style.batchBtn} onClick={this.props.onBatch}>
              Batch process a folder
            </button>
          )}
          <p class={style.demoTitle}>Or try one of these:</p>
          <ul class={style.demos}>
            {demos.map((demo, i) => (
              <li>
                <button
                  class={style.demoButton}
                  onClick={() => this.onDemoClick(i)}
                >
                  <div class={style.demoIconContainer}>
                    <img
                      class={style.demoIcon}
                      src={demo.iconUrl}
                      alt={demo.description}
                      width="56"
                      height="56"
                    />
                    {fetchingDemoIndex === i && (
                      <div class={style.demoLoader}>
                        <loading-spinner />
                      </div>
                    )}
                  </div>
                  <div class={style.demoText}>
                    <span class={style.demoName}>{demo.description}</span>
                    <span class={style.demoSize}>({demo.size})</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <footer class={style.footer}>
          <a
            class={style.footerLink}
            href="https://github.com/GoogleChromeLabs/squoosh"
          >
            View the code
          </a>
          <a
            class={style.footerLink}
            href="https://github.com/GoogleChromeLabs/squoosh/issues/new"
          >
            Report a bug
          </a>
          <a
            class={style.footerLink}
            href="https://github.com/GoogleChromeLabs/squoosh/blob/dev/README.md#privacy"
          >
            Privacy
          </a>
        </footer>
      </div>
    );
  }
}
