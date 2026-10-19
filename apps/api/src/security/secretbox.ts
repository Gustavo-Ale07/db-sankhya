import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals a secret with AES-256-GCM. The AAD binds the ciphertext to its owner and field
 * (`connectionId + ':' + fieldName`), so a value copied to another row or column does not decrypt.
 * Output: `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */
export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

/** Opens a value sealed by `encryptSecret`. Throws on any tampering, wrong key or wrong AAD. */
export function decryptSecret(key: Buffer, sealed: string, aad: string): string {
  assertKey(key);
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported sealed secret');
  const [, ivText, tagText, ctText] = parts as [string, string, string, string];
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new Error('Malformed sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(ctText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function assertKey(key: Buffer) {
  if (key.length !== 32) throw new Error('The encryption key must be 32 bytes');
}
