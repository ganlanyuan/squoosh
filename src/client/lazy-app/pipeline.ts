import {
  blobToImg,
  blobToText,
  builtinDecode,
  sniffMimeType,
  canDecodeImageType,
  abortable,
  assertSignal,
  ImageMimeTypes,
} from './util';
import { drawableToImageData } from './util/canvas';
import {
  PreprocessorState,
  ProcessorState,
  EncoderState,
  encoderMap,
} from './feature-meta';
import WorkerBridge from './worker-bridge';
import { resize } from 'features/processors/resize/client';

export interface SourceImage {
  file: File;
  decoded: ImageData;
  preprocessed: ImageData;
  vectorImage?: HTMLImageElement;
}

export async function decodeImage(
  signal: AbortSignal,
  blob: Blob,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  const mimeType = await abortable(signal, sniffMimeType(blob));
  const canDecode = await abortable(signal, canDecodeImageType(mimeType));

  try {
    if (!canDecode) {
      if (mimeType === 'image/avif') {
        return await workerBridge.avifDecode(signal, blob);
      }
      if (mimeType === 'image/webp') {
        return await workerBridge.webpDecode(signal, blob);
      }
      if (mimeType === 'image/jxl') {
        return await workerBridge.jxlDecode(signal, blob);
      }
      if (mimeType === 'image/webp2') {
        return await workerBridge.wp2Decode(signal, blob);
      }
      if (mimeType === 'image/qoi') {
        return await workerBridge.qoiDecode(signal, blob);
      }
    }
    // Otherwise fall through and try built-in decoding for a laugh.
    return await builtinDecode(signal, blob);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    console.log(err);
    throw Error("Couldn't decode image");
  }
}

export async function preprocessImage(
  signal: AbortSignal,
  data: ImageData,
  preprocessorState: PreprocessorState,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  let processedData = data;

  if (preprocessorState.rotate.rotate !== 0) {
    processedData = await workerBridge.rotate(
      signal,
      processedData,
      preprocessorState.rotate,
    );
  }

  return processedData;
}

export async function processImage(
  signal: AbortSignal,
  source: SourceImage,
  processorState: ProcessorState,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  let result = source.preprocessed;

  if (processorState.resize.enabled) {
    result = await resize(signal, source, processorState.resize, workerBridge);
  }
  if (processorState.quantize.enabled) {
    result = await workerBridge.quantize(
      signal,
      result,
      processorState.quantize,
    );
  }
  return result;
}

export async function compressImage(
  signal: AbortSignal,
  image: ImageData,
  encodeData: EncoderState,
  sourceFilename: string,
  workerBridge: WorkerBridge,
): Promise<File> {
  assertSignal(signal);

  const encoder = encoderMap[encodeData.type];
  const compressedData = await encoder.encode(
    signal,
    workerBridge,
    image,
    // The type of encodeData.options is enforced via the previous line
    encodeData.options as any,
  );

  // This type ensures the image mimetype is consistent with our mimetype sniffer
  const type: ImageMimeTypes = encoder.meta.mimeType;

  return new File(
    [compressedData],
    sourceFilename.replace(/.[^.]*$/, `.${encoder.meta.extension}`),
    { type },
  );
}

export async function processSvg(
  signal: AbortSignal,
  blob: Blob,
): Promise<HTMLImageElement> {
  assertSignal(signal);
  // Firefox throws if you try to draw an SVG to canvas that doesn't have width/height.
  // In Chrome it loads, but drawImage behaves weirdly.
  // This function sets width/height if it isn't already set.
  const parser = new DOMParser();
  const text = await abortable(signal, blobToText(blob));
  const document = parser.parseFromString(text, 'image/svg+xml');
  const svg = document.documentElement!;

  if (svg.hasAttribute('width') && svg.hasAttribute('height')) {
    return blobToImg(blob);
  }

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox === null) throw Error('SVG must have width/height or viewBox');

  const viewboxParts = viewBox.split(/\s+/);
  svg.setAttribute('width', viewboxParts[2]);
  svg.setAttribute('height', viewboxParts[3]);

  const serializer = new XMLSerializer();
  const newSource = serializer.serializeToString(document);
  return abortable(
    signal,
    blobToImg(new Blob([newSource], { type: 'image/svg+xml' })),
  );
}

export interface BatchSettings {
  preprocessorState: PreprocessorState;
  processorState: ProcessorState;
  encoderState: EncoderState;
  /**
   * If set (and not 100), each image is resized to this percentage of its own
   * dimensions. Batch images vary in size, so a percentage fits better than the
   * editor's absolute width/height.
   */
  resizePercent?: number;
}

/**
 * Run the full decode → preprocess → process → encode pipeline for a single
 * file using one shared settings object. Used by batch processing.
 */
export async function processImageFile(
  signal: AbortSignal,
  file: File,
  settings: BatchSettings,
  workerBridge: WorkerBridge,
): Promise<File> {
  assertSignal(signal);

  let decoded: ImageData;
  let vectorImage: HTMLImageElement | undefined;

  if (file.type.startsWith('image/svg+xml')) {
    vectorImage = await processSvg(signal, file);
    decoded = drawableToImageData(vectorImage);
  } else {
    decoded = await decodeImage(signal, file, workerBridge);
  }

  const preprocessed = await preprocessImage(
    signal,
    decoded,
    settings.preprocessorState,
    workerBridge,
  );

  const source: SourceImage = { file, decoded, preprocessed, vectorImage };

  // Apply percentage resize per-image, based on this image's own dimensions.
  let processorState = settings.processorState;
  if (settings.resizePercent != null && settings.resizePercent !== 100) {
    const scale = settings.resizePercent / 100;
    processorState = {
      ...processorState,
      resize: {
        ...processorState.resize,
        enabled: true,
        width: Math.max(1, Math.round(decoded.width * scale)),
        height: Math.max(1, Math.round(decoded.height * scale)),
        ...(vectorImage ? { method: 'vector' } : {}),
      } as ProcessorState['resize'],
    };
  }

  const processed = await processImage(
    signal,
    source,
    processorState,
    workerBridge,
  );

  return compressImage(
    signal,
    processed,
    settings.encoderState,
    file.name,
    workerBridge,
  );
}
