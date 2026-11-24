import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { safeStorage } from 'electron';

const KEYCHAIN: Partial<Record<NodeJS.Platform, string>> = { darwin: 'The Mac Keychain', win32: 'Windows encryption' };

/** The Garmin key, encrypted with the system keychain (Keychain on a Mac, the Secret Service or KWallet on Linux). */
export class KeyFile {
  private file: string;
  private allowPlain: boolean;
  /** `allowPlain` lets tests run on Linux machines with no keyring. Never set it in the app people use. */
  constructor(file: string, { allowPlain = false } = {}) {
    this.file = file;
    this.allowPlain = allowPlain;
  }
  async save(key: string) {
    const keychain = KEYCHAIN[process.platform] ?? 'The system keyring';
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error(`${keychain} is not available, so the key cannot be saved safely.`);
    // With no keyring running, Linux falls back to a fixed built-in password, which protects nothing.
    if (process.platform === 'linux' && !this.allowPlain && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())) {
      throw new Error('No system keyring is running (such as GNOME Keyring or KWallet), so the key cannot be saved safely.');
    }
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
