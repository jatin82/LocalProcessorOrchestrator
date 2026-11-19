import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const pairingLifetime = 5 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest();
const matches = (value, hash) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) &&
  hash != null && timingSafeEqual(digest(value), hash);

export class BrowserPairing {
  #file;
  #sessionHash;
  #inviteHash;
  #expiresAt;

  constructor(dataDir) {
    this.#file = path.join(dataDir, 'paired-browser.sha256');
    let saved;
    try { saved = readFileSync(this.#file, 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!/^[a-f0-9]{64}$/.test(saved)) throw new Error(`Invalid browser pairing record: ${this.#file}`);
    this.#sessionHash = Buffer.from(saved, 'hex');
  }

  get paired() { return !!this.#sessionHash; }

  invite() {
    const code = randomBytes(32).toString('hex');
    this.#inviteHash = digest(code);
    this.#expiresAt = Date.now() + pairingLifetime;
    return code;
  }

  redeem(code) {
    if (!matches(code, this.#inviteHash) || Date.now() >= this.#expiresAt) return null;
    const session = randomBytes(32).toString('hex');
    const hash = digest(session);
    writeFileSync(`${this.#file}.tmp`, hash.toString('hex') + '\n', { mode: 0o600 });
    renameSync(`${this.#file}.tmp`, this.#file);
    this.#sessionHash = hash;
    this.#inviteHash = undefined;
    return session;
  }

  accepts(session) { return matches(session, this.#sessionHash); }
}
