import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('server-only', () => ({}));
const { processImage } = await import('./images');

/** A solid JPEG of the given size, optionally carrying an EXIF orientation. */
async function jpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 3, background: '#3366aa' } }).jpeg();
  return (orientation ? image.withMetadata({ orientation }) : image).toBuffer();
}

async function sizeOf(input: Buffer) {
  const result = await processImage(input);
  if (!result.ok) throw new Error(result.reason);
  return { width: result.image.width, height: result.image.height };
}

describe('processImage - Instagram-style feed sizing', () => {
  it('keeps a 3:4 phone portrait whole (no crop), capped at 1080 wide', async () => {
    expect(await sizeOf(await jpeg(3000, 4000))).toEqual({ width: 1080, height: 1440 });
  });

  it('keeps a 4:3 landscape whole', async () => {
    expect(await sizeOf(await jpeg(4000, 3000))).toEqual({ width: 1080, height: 810 });
  });

  it('keeps a square whole', async () => {
    expect(await sizeOf(await jpeg(2000, 2000))).toEqual({ width: 1080, height: 1080 });
  });

  it('centre-crops a very tall image only down to 3:4', async () => {
    expect(await sizeOf(await jpeg(1000, 3000))).toEqual({ width: 1000, height: 1333 });
  });

  it('centre-crops a panorama only down to 1.91:1', async () => {
    expect(await sizeOf(await jpeg(4000, 1000))).toEqual({ width: 1080, height: 565 });
  });

  it('never upscales a small image', async () => {
    expect(await sizeOf(await jpeg(400, 300))).toEqual({ width: 400, height: 300 });
  });

  it('honours EXIF rotation: a phone portrait stored sideways stays portrait', async () => {
    // Stored 4000x3000 with orientation 6 (rotate 90) = a 3000x4000 portrait.
    expect(await sizeOf(await jpeg(4000, 3000, 6))).toEqual({ width: 1080, height: 1440 });
  });
});
