// Password hashing using Web Crypto API (works in Cloudflare Workers)
// Uses PBKDF2 with SHA-256 — no bcrypt in Workers runtime

const ITERATIONS = 100000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = await deriveKey(password, salt);
  const hashBuffer = await crypto.subtle.exportKey("raw", key) as ArrayBuffer;
  const hashArray = new Uint8Array(hashBuffer);

  // Store as: iterations:salt:hash (all base64)
  return `${ITERATIONS}:${toBase64(salt)}:${toBase64(hashArray)}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3) return false;

  const iterations = parseInt(parts[0]);
  const salt = fromBase64(parts[1]);
  const storedHash = fromBase64(parts[2]);

  const key = await deriveKey(password, salt, iterations);
  const hashBuffer = await crypto.subtle.exportKey("raw", key) as ArrayBuffer;
  const hashArray = new Uint8Array(hashBuffer);

  // Constant-time comparison
  if (hashArray.length !== storedHash.length) return false;
  let result = 0;
  for (let i = 0; i < hashArray.length; i++) {
    result |= hashArray[i] ^ storedHash[i];
  }
  return result === 0;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = ITERATIONS
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: KEY_LENGTH * 8 },
    true,
    ["encrypt"]
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function validatePassword(password: string): string | null {
  if (!password || password.length < 8) {
    return "Password must be at least 8 characters long";
  }
  if (password.length > 128) {
    return "Password must be 128 characters or fewer";
  }
  if (!/\d/.test(password)) {
    return "Password must contain at least one number";
  }
  return null;
}
