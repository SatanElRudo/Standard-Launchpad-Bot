import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { File } from 'node:buffer';

export async function uploadImageToCatbox(buffer, filename = 'image.png', mimeType = 'image/png') {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const file = new File([buffer], filename, { type: mimeType });
      const fd = new FormData();
      fd.append('reqtype', 'fileupload');
      fd.append('fileToUpload', file);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch('https://catbox.moe/user/api.php', {
          method: 'POST',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          body: fd,
          signal: controller.signal,
        });
        if (res.ok) {
          const text = (await res.text()).trim();
          if (text.startsWith('https://')) return text;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500 * attempt));
  }
  throw new Error('Bild-Upload zu Catbox fehlgeschlagen.');
}

export async function uploadMetadataJson(metadataObj) {
  const jsonStr = JSON.stringify(metadataObj, null, 2);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch('https://paste.rs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: jsonStr,
          signal: controller.signal,
        });
        if (res.ok) {
          const text = (await res.text()).trim();
          if (text.startsWith('http://') || text.startsWith('https://')) {
            return text.replace('http://', 'https://');
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500 * attempt));
  }
  throw new Error('Metadaten-Hosting fehlgeschlagen.');
}

export async function hostImageAndMetadata({
  name = 'Token',
  symbol = 'TKN',
  description = '',
  website = '',
  imageBuffer = null,
  imageMime = 'image/png',
  imageFilename = 'image.png',
  sampleAsset = null,
  existingImageUrl = null,
  assetDir = resolve('assets'),
} = {}) {
  let imageUrl = existingImageUrl;

  if (imageBuffer) {
    imageUrl = await uploadImageToCatbox(imageBuffer, imageFilename, imageMime);
  } else if (sampleAsset) {
    const safeName = sampleAsset.replace(/[^a-zA-Z0-9._-]/g, '');
    const assetPath = resolve(assetDir, safeName);
    const buf = await readFile(assetPath);
    const ext = extname(safeName).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    imageUrl = await uploadImageToCatbox(buf, safeName, mime);
  }

  if (!imageUrl) {
    throw new Error('Kein Bild übergeben (weder Bilddatei noch Sample-Asset).');
  }

  const metadata = {
    name: name.trim() || 'Token',
    symbol: symbol.trim() || 'TKN',
    description: description.trim(),
    image: imageUrl,
    website: website.trim(),
  };

  const metadataURI = await uploadMetadataJson(metadata);

  return {
    image: imageUrl,
    metadataURI,
    metadata,
  };
}

export async function listSampleAssets(assetDir = resolve('assets')) {
  try {
    const files = await readdir(assetDir);
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
    const list = [];
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      if (allowed.has(ext)) {
        const s = await stat(resolve(assetDir, f));
        list.push({ filename: f, size: s.size });
      }
    }
    return list;
  } catch {
    return [];
  }
}
