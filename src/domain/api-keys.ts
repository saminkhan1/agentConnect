import crypto from 'node:crypto';

export type ApiKeyType = 'root' | 'service';

type GeneratedApiKey = {
  id: string;
  keyHash: string;
  plaintextKey: string;
};

const API_KEY_PREFIX = 'sk';
const API_KEY_ID_PREFIX = 'key';

function generateApiKeyId(): string {
  return `${API_KEY_ID_PREFIX}_${crypto.randomUUID()}`;
}

function hashApiKeySecret(secret: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function generateApiKeyMaterial(): GeneratedApiKey {
  const id = generateApiKeyId();
  const secret = crypto.randomBytes(32).toString('base64url');
  const keyHash = hashApiKeySecret(secret);

  return {
    id,
    keyHash,
    plaintextKey: `${API_KEY_PREFIX}_${id}.${secret}`,
  };
}
