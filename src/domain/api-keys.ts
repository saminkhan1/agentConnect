import crypto from "node:crypto";

export type ApiKeyType = "root" | "service";
export type ApiScope = "api_keys:write" | "agents:read" | "agents:write";

type GeneratedApiKey = {
	id: string;
	keyHash: string;
	plaintextKey: string;
};

type ParsedApiKey = {
	keyId: string;
	secret: string;
};

const API_KEY_PREFIX = "sk";
const API_KEY_ID_PREFIX = "key";
const HASH_ALGORITHM = "scrypt";
const HASH_KEY_LENGTH = 64;

const scopesByApiKeyType: Record<ApiKeyType, ApiScope[]> = {
	root: ["api_keys:write", "agents:read", "agents:write"],
	service: ["agents:read", "agents:write"],
};

function generateApiKeyId(): string {
	return `${API_KEY_ID_PREFIX}_${crypto.randomUUID()}`;
}

async function hashApiKeySecret(secret: string): Promise<string> {
	const salt = crypto.randomBytes(16).toString("hex");
	const key = (await deriveKey(secret, salt)).toString("hex");
	return `${HASH_ALGORITHM}$${salt}$${key}`;
}

function parseRawApiKey(rawApiKey: string): ParsedApiKey | null {
	const prefix = `${API_KEY_PREFIX}_`;
	if (!rawApiKey.startsWith(prefix)) {
		return null;
	}

	const payload = rawApiKey.slice(prefix.length);
	const delimiterIndex = payload.indexOf(".");
	if (delimiterIndex <= 0 || delimiterIndex === payload.length - 1) {
		return null;
	}

	const keyId = payload.slice(0, delimiterIndex);
	const secret = payload.slice(delimiterIndex + 1);
	if (keyId.length === 0 || secret.length === 0) {
		return null;
	}

	return { keyId, secret };
}

function parseHashParts(
	storedHash: string,
): { salt: string; keyHex: string } | null {
	const parts = storedHash.split("$");
	if (parts.length !== 3 || parts[0] !== HASH_ALGORITHM) {
		return null;
	}

	const salt = parts[1];
	const keyHex = parts[2];
	if (
		salt.length !== 32 ||
		keyHex.length === 0 ||
		keyHex.length !== HASH_KEY_LENGTH * 2 ||
		keyHex.length % 2 !== 0 ||
		!/^[0-9a-f]+$/i.test(salt) ||
		!/^[0-9a-f]+$/i.test(keyHex)
	) {
		return null;
	}

	return { salt, keyHex };
}

export async function generateApiKeyMaterial(): Promise<GeneratedApiKey> {
	const id = generateApiKeyId();
	const secret = crypto.randomBytes(32).toString("base64url");
	const keyHash = await hashApiKeySecret(secret);

	return {
		id,
		keyHash,
		plaintextKey: `${API_KEY_PREFIX}_${id}.${secret}`,
	};
}

export function parseApiKeyFromAuthorizationHeader(
	headerValue: string,
): ParsedApiKey | null {
	const pieces = headerValue.trim().split(/\s+/);
	if (pieces.length !== 2) {
		return null;
	}

	if (pieces[0].toLowerCase() !== "bearer") {
		return null;
	}

	return parseRawApiKey(pieces[1]);
}

async function deriveKey(secret: string, salt: string): Promise<Buffer> {
	return await new Promise<Buffer>((resolve, reject) => {
		crypto.scrypt(secret, salt, HASH_KEY_LENGTH, (err, derivedKey) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(Buffer.from(derivedKey));
		});
	});
}

export async function verifyApiKeySecret(
	secret: string,
	storedHash: string,
): Promise<boolean> {
	const parsedHash = parseHashParts(storedHash);
	if (!parsedHash) {
		return false;
	}

	try {
		const expectedKey = Buffer.from(parsedHash.keyHex, "hex");
		const derivedKey = await deriveKey(secret, parsedHash.salt);
		if (derivedKey.length !== expectedKey.length) {
			return false;
		}
		return crypto.timingSafeEqual(derivedKey, expectedKey);
	} catch {
		return false;
	}
}

export function getScopesForApiKeyType(keyType: ApiKeyType): ApiScope[] {
	return [...scopesByApiKeyType[keyType]];
}
