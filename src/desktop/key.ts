import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { safeStorage } from 'electron';

/** The Garmin key, encrypted with the Mac's Keychain. */
export class KeyFile {
  private file: string;
  constructor(file: string) {
    this.file = file;
  }
  async save(key: string) {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('The Mac Keychain is not available, so the key cannot be saved safely.');
    const tmp = `${this.file}.part`;
    await writeFile(tmp, await safeStorage.encryptStringAsync(key), { mode: 0o600 });
    await rename(tmp, this.file);
  }
  /** Null when there is no key. Throws when there is one that cannot be read. */
  async load(): Promise<string | null> {
    let data: Buffer;
    try {
      data = await readFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    return (await safeStorage.decryptStringAsync(data)).result;
  }
  async exists() {
    return readFile(this.file).then(() => true, () => false);
  }
  remove() {
    return rm(this.file, { force: true });
  }
}
