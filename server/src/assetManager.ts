import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AssetMetadata } from './types.ts';

/**
 * Magic byte signatures for safe file validation
 */
const MAGIC_SIGNATURES = {
  PNG: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  JPEG: Buffer.from([0xff, 0xd8, 0xff]),
  PDF: Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
};

export class AssetManager {
  private storageDir: string;
  private metadataFile: string;
  private metadataMap: Map<string, AssetMetadata> = new Map();
  private maxSizeBytes: number;

  constructor(
    storageDir: string = path.join(process.cwd(), 'server', 'uploads'),
    maxSizeBytes: number = 25 * 1024 * 1024 // 25 MB
  ) {
    this.storageDir = storageDir;
    this.metadataFile = path.join(storageDir, 'metadata.json');
    this.maxSizeBytes = maxSizeBytes;

    this.initStorage();
  }

  private initStorage(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    if (fs.existsSync(this.metadataFile)) {
      try {
        const raw = fs.readFileSync(this.metadataFile, 'utf-8');
        const list: AssetMetadata[] = JSON.parse(raw);
        for (const meta of list) {
          this.metadataMap.set(meta.assetId, meta);
        }
      } catch (err) {
        console.error('Failed to load asset metadata file, initializing empty registry', err);
      }
    } else {
      this.saveMetadataToDisk();
    }
  }

  private saveMetadataToDisk(): void {
    try {
      const list = Array.from(this.metadataMap.values());
      fs.writeFileSync(this.metadataFile, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to persist asset metadata to disk', err);
    }
  }

  /**
   * Validates buffer contents against claimed MIME type and magic signatures
   */
  public validateFile(
    buffer: Buffer,
    claimedMimeType: string,
    fileName: string
  ): { valid: boolean; detectedType: 'image' | 'file' | 'csv' | 'pdf'; actualMime: string; error?: string } {
    if (buffer.length === 0) {
      return { valid: false, detectedType: 'file', actualMime: '', error: 'FILE_EMPTY' };
    }
    if (buffer.length > this.maxSizeBytes) {
      return {
        valid: false,
        detectedType: 'file',
        actualMime: '',
        error: `FILE_TOO_LARGE: ${buffer.length} exceeds max ${this.maxSizeBytes} bytes`,
      };
    }

    // PNG check
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(MAGIC_SIGNATURES.PNG)) {
      return { valid: true, detectedType: 'image', actualMime: 'image/png' };
    }

    // JPEG check
    if (buffer.length >= 3 && buffer.subarray(0, 3).equals(MAGIC_SIGNATURES.JPEG)) {
      return { valid: true, detectedType: 'image', actualMime: 'image/jpeg' };
    }

    // PDF check
    if (buffer.length >= 4 && buffer.subarray(0, 4).equals(MAGIC_SIGNATURES.PDF)) {
      return { valid: true, detectedType: 'pdf', actualMime: 'application/pdf' };
    }

    // CSV / text check: must not contain binary null bytes and must have .csv extension or text/csv mime
    const ext = path.extname(fileName).toLowerCase();
    const isCsvExt = ext === '.csv';
    const isCsvMime = claimedMimeType === 'text/csv' || claimedMimeType === 'application/csv';

    if (isCsvExt || isCsvMime) {
      // Sample first 4KB for binary control null bytes
      const sampleSize = Math.min(buffer.length, 4096);
      let isBinary = false;
      for (let i = 0; i < sampleSize; i++) {
        if (buffer[i] === 0x00) {
          isBinary = true;
          break;
        }
      }

      if (!isBinary) {
        return { valid: true, detectedType: 'csv', actualMime: 'text/csv' };
      }
    }

    // Safe general file types (e.g. text, markdown, json)
    if (ext === '.txt' || ext === '.json' || ext === '.md') {
      return { valid: true, detectedType: 'file', actualMime: claimedMimeType || 'text/plain' };
    }

    // If claimed MIME type contradicts signature
    return {
      valid: false,
      detectedType: 'file',
      actualMime: claimedMimeType,
      error: `INVALID_FILE_SIGNATURE: Content signature does not match supported formats (PNG, JPEG, PDF, CSV)`,
    };
  }

  /**
   * Extracts image dimensions for PNG and JPEG without external dependencies
   */
  public extractImageDimensions(buffer: Buffer, mimeType: string): { width?: number; height?: number } {
    try {
      if (mimeType === 'image/png' && buffer.length >= 24) {
        // PNG IHDR chunk stores 4-byte width at offset 16, 4-byte height at offset 20
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return { width, height };
      }

      if (mimeType === 'image/jpeg' && buffer.length > 4) {
        let offset = 2;
        while (offset < buffer.length - 8) {
          if (buffer[offset] !== 0xff) break;
          const marker = buffer[offset + 1];

          // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
          if (marker >= 0xc0 && marker <= 0xc2) {
            const height = buffer.readUInt16BE(offset + 5);
            const width = buffer.readUInt16BE(offset + 7);
            return { width, height };
          }

          // Move to next marker
          const length = buffer.readUInt16BE(offset + 2);
          offset += 2 + length;
        }
      }
    } catch {
      // Gracefully fall back if image header is non-standard
    }
    return {};
  }

  /**
   * Saves an uploaded file buffer to disk and registers metadata
   */
  public async saveAsset(
    documentId: string,
    originalFileName: string,
    claimedMimeType: string,
    buffer: Buffer
  ): Promise<AssetMetadata> {
    const validation = this.validateFile(buffer, claimedMimeType, originalFileName);
    if (!validation.valid) {
      throw new Error(validation.error || 'VALIDATION_FAILED');
    }

    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const assetId = `asset_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const ext = path.extname(originalFileName) || (validation.detectedType === 'image' ? '.png' : '');
    const storageKey = `${assetId}${ext}`;
    const filePath = path.join(this.storageDir, storageKey);

    // Write binary bytes to disk
    await fs.promises.writeFile(filePath, buffer);

    const dimensions = validation.detectedType === 'image'
      ? this.extractImageDimensions(buffer, validation.actualMime)
      : {};

    const metadata: AssetMetadata = {
      assetId,
      documentId,
      type: validation.detectedType,
      mimeType: validation.actualMime,
      originalFileName,
      sizeBytes: buffer.length,
      width: dimensions.width,
      height: dimensions.height,
      checksum,
      storageKey,
      createdAt: Date.now(),
      uploadStatus: 'ready',
    };

    this.metadataMap.set(assetId, metadata);
    this.saveMetadataToDisk();

    return metadata;
  }

  /**
   * Retrieves asset metadata and safe file path
   * Strictly prevents path traversal
   */
  public getAsset(assetId: string): { metadata: AssetMetadata; filePath: string } {
    // Sanitize assetId to alphanumeric + underscore
    if (!/^[a-zA-Z0-9_-]+$/.test(assetId)) {
      throw new Error('INVALID_ASSET_ID');
    }

    const metadata = this.metadataMap.get(assetId);
    if (!metadata) {
      throw new Error(`ASSET_NOT_FOUND: ${assetId}`);
    }

    const filePath = path.join(this.storageDir, metadata.storageKey);
    // Path traversal check
    const resolvedPath = path.resolve(filePath);
    const resolvedStorageDir = path.resolve(this.storageDir);

    if (!resolvedPath.startsWith(resolvedStorageDir)) {
      throw new Error('ACCESS_DENIED: Path traversal detected');
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`ASSET_FILE_MISSING: ${metadata.storageKey}`);
    }

    return { metadata, filePath: resolvedPath };
  }

  /**
   * Retrieves all assets associated with a document
   */
  public getAssetsForDocument(documentId: string): AssetMetadata[] {
    const list: AssetMetadata[] = [];
    for (const meta of this.metadataMap.values()) {
      if (meta.documentId === documentId) {
        list.push(meta);
      }
    }
    return list;
  }

  /**
   * Deletes an asset only if safe
   */
  public deleteAsset(assetId: string): boolean {
    if (!this.metadataMap.has(assetId)) return false;
    const { filePath } = this.getAsset(assetId);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    this.metadataMap.delete(assetId);
    this.saveMetadataToDisk();
    return true;
  }
}

