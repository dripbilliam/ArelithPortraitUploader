type PortraitSpec = {
  suffix: "H" | "L" | "M" | "S" | "T";
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
};

const portraitSpecs: PortraitSpec[] = [
  { suffix: "H", width: 256, height: 512, displayWidth: 256, displayHeight: 400 },
  { suffix: "L", width: 128, height: 256, displayWidth: 128, displayHeight: 200 },
  { suffix: "M", width: 64, height: 128, displayWidth: 64, displayHeight: 100 },
  { suffix: "S", width: 32, height: 64, displayWidth: 32, displayHeight: 50 },
  { suffix: "T", width: 16, height: 32, displayWidth: 16, displayHeight: 25 },
];

function buildTgaFromCanvas(canvas: HTMLCanvasElement): Uint8Array {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get canvas context for TGA encoding");
  }

  const image = ctx.getImageData(0, 0, width, height);
  const pixelCount = width * height;
  const headerSize = 18;
  const bytes = new Uint8Array(headerSize + pixelCount * 3);

  // TGA header (uncompressed true-color, 24-bit)
  bytes[0] = 0; // id length
  bytes[1] = 0; // color map type
  bytes[2] = 2; // image type (uncompressed true-color)
  bytes[12] = width & 0xff;
  bytes[13] = (width >> 8) & 0xff;
  bytes[14] = height & 0xff;
  bytes[15] = (height >> 8) & 0xff;
  bytes[16] = 24; // pixel depth
  bytes[17] = 0; // image descriptor (origin bottom-left)

  let out = headerSize;
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = image.data[idx];
      const g = image.data[idx + 1];
      const b = image.data[idx + 2];
      bytes[out++] = b;
      bytes[out++] = g;
      bytes[out++] = r;
    }
  }

  return bytes;
}

function renderPortraitCanvas(source: CanvasImageSource, spec: PortraitSpec): HTMLCanvasElement {
  const displayCanvas = document.createElement("canvas");
  displayCanvas.width = spec.displayWidth;
  displayCanvas.height = spec.displayHeight;
  const displayCtx = displayCanvas.getContext("2d");
  if (!displayCtx) {
    throw new Error("Could not create display canvas context");
  }

  displayCtx.fillStyle = "black";
  displayCtx.fillRect(0, 0, spec.displayWidth, spec.displayHeight);

  const sourceWidth = source instanceof HTMLImageElement ? source.naturalWidth : (source as ImageBitmap).width;
  const sourceHeight = source instanceof HTMLImageElement ? source.naturalHeight : (source as ImageBitmap).height;

  const scale = Math.max(spec.displayWidth / sourceWidth, spec.displayHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = (spec.displayWidth - drawWidth) / 2;
  const drawY = 0;

  displayCtx.drawImage(source, drawX, drawY, drawWidth, drawHeight);

  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = spec.width;
  finalCanvas.height = spec.height;
  const finalCtx = finalCanvas.getContext("2d");
  if (!finalCtx) {
    throw new Error("Could not create final canvas context");
  }

  finalCtx.fillStyle = "black";
  finalCtx.fillRect(0, 0, spec.width, spec.height);
  finalCtx.drawImage(displayCanvas, 0, 0);

  return finalCanvas;
}

export async function convertImageToTgaVariants(file: File): Promise<Array<{ suffix: PortraitSpec["suffix"]; blob: Blob }>> {
  const bitmap = await createImageBitmap(file);
  try {
    return portraitSpecs.map((spec) => {
      const canvas = renderPortraitCanvas(bitmap, spec);
      const tgaBytes = buildTgaFromCanvas(canvas);
      const blobBytes = tgaBytes as unknown as Uint8Array<ArrayBuffer>;
      return {
        suffix: spec.suffix,
        blob: new Blob([blobBytes], { type: "image/x-tga" }),
      };
    });
  } finally {
    bitmap.close();
  }
}
