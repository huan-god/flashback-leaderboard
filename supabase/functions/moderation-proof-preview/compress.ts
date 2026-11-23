import { Image } from "jsr:@matmen/imagescript@3.20.5";

export const maxScreenshotBytes = 5 * 1024 * 1024;

export async function compressProof(file: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  if (!file.byteLength || file.byteLength > maxScreenshotBytes) {
    throw new Error("Invalid screenshot size");
  }
  const image = await Image.decode(new Uint8Array(file), {
    maxPixels: 12_000_000,
    threads: 1,
    gainMap: false,
  });
  const scale = Math.min(1, 960 / Math.max(image.width, image.height));
  if (scale < 1) {
    image.resize(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  }
  return Uint8Array.from(await image.encodeJPEG({ quality: 72 }));
}
