/**
 * Decoded-image cache for the viewer. Photos are decoded off the main thread
 * into `ImageBitmap`s ahead of time, so flipping to the next photo is a canvas
 * redraw instead of a load + decode. Memory is bounded explicitly: previews
 * are ~17 MB decoded, originals ~96 MB, so far fewer originals are kept.
 */

/** Anything the canvas can draw. */
export type Frame = ImageBitmap | HTMLImageElement;

class FrameCache {
  private frames = new Map<string, Frame>();
  private pending = new Map<string, Promise<Frame>>();

  constructor(private capacity: number) {}

  /** A decoded frame if it's ready, without waiting. Refreshes its LRU slot. */
  peek(url: string): Frame | undefined {
    const f = this.frames.get(url);
    if (f) {
      this.frames.delete(url);
      this.frames.set(url, f);
    }
    return f;
  }

  /** Decode (once) and cache the image at `url`. */
  load(url: string): Promise<Frame> {
    const ready = this.peek(url);
    if (ready) return Promise.resolve(ready);
    const inflight = this.pending.get(url);
    if (inflight) return inflight;

    const p = decode(url)
      .then((frame) => {
        this.frames.set(url, frame);
        this.evict();
        return frame;
      })
      .finally(() => this.pending.delete(url));
    this.pending.set(url, p);
    return p;
  }

  /** Keep these decoded (most important first); errors are ignored. */
  prefetch(urls: string[]) {
    for (const url of urls) void this.load(url).catch(() => {});
  }

  private evict() {
    while (this.frames.size > this.capacity) {
      const oldest = this.frames.keys().next().value as string;
      const frame = this.frames.get(oldest);
      this.frames.delete(oldest);
      if (frame && "close" in frame) frame.close();
    }
  }
}

async function decode(url: string): Promise<Frame> {
  if (typeof createImageBitmap === "function") {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await createImageBitmap(await res.blob());
    } catch {
      // Fall through to <img>, which every webview can decode.
    }
  }
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return img;
}

/** Previews of the photo on screen and its neighbours. */
export const previewFrames = new FrameCache(16);
/** Thumbnails, used as an instant placeholder while a preview decodes. */
export const thumbFrames = new FrameCache(400);
/** Full-resolution originals, only for zooming past the preview's detail. */
export const originalFrames = new FrameCache(2);

/** Natural size of a frame. */
export function frameSize(f: Frame): { w: number; h: number } {
  return f instanceof HTMLImageElement
    ? { w: f.naturalWidth, h: f.naturalHeight }
    : { w: f.width, h: f.height };
}
