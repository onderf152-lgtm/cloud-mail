// AES-256-GCM helpers for per-account SMTP passwords.
// Master key: Workers Secret SMTP_CREDENTIALS_KEY (never log plaintext).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToB64(bytes) {
	let binary = '';
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	for (let i = 0; i < view.length; i += 0x8000) {
		binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function b64ToBytes(b64) {
	const binary = atob(String(b64 || ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Only accept a true 32-byte key:
 * - 64 hex chars, or
 * - base64/base64url that decodes to exactly 32 bytes.
 * Reject weak passphrases (no SHA-256 stretch fallback).
 */
function parseMasterKeyBytes(rawKeyMaterial) {
	if (!rawKeyMaterial || !String(rawKeyMaterial).trim()) {
		throw new Error('SMTP_CREDENTIALS_KEY is missing');
	}
	const raw = String(rawKeyMaterial).trim();
	if (/^[0-9a-fA-F]{64}$/.test(raw)) {
		return new Uint8Array(raw.match(/.{2}/g).map(h => parseInt(h, 16)));
	}
	try {
		const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
		const pad = normalized.length % 4 === 0 ? normalized : normalized + '='.repeat(4 - (normalized.length % 4));
		const decoded = b64ToBytes(pad);
		if (decoded.byteLength === 32) {
			return decoded;
		}
	} catch {
		// fall through to invalid-key error
	}
	throw new Error('SMTP_CREDENTIALS_KEY must be 64 hex chars or base64 of 32 bytes');
}

async function importMasterKey(rawKeyMaterial) {
	const keyBytes = parseMasterKeyBytes(rawKeyMaterial);
	return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function aadForAccount(accountId) {
	return encoder.encode(`cloud-mail:account-smtp:${Number(accountId)}`);
}

const smtpSecretUtils = {
	KEY_VER: 1,

	async encryptPassword(env, accountId, password) {
		const plain = String(password ?? '');
		if (!plain) {
			throw new Error('SMTP password is empty');
		}
		const key = await importMasterKey(env.SMTP_CREDENTIALS_KEY);
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const cipherBuf = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: aadForAccount(accountId) },
			key,
			encoder.encode(plain)
		);
		return {
			passCipher: bytesToB64(cipherBuf),
			passIv: bytesToB64(iv),
			keyVer: this.KEY_VER
		};
	},

	async decryptPassword(env, accountId, passCipher, passIv, keyVer = 1) {
		if (Number(keyVer) !== this.KEY_VER) {
			throw new Error('Unsupported SMTP credential key version');
		}
		const key = await importMasterKey(env.SMTP_CREDENTIALS_KEY);
		try {
			const plainBuf = await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: b64ToBytes(passIv),
					additionalData: aadForAccount(accountId)
				},
				key,
				b64ToBytes(passCipher)
			);
			return decoder.decode(plainBuf);
		} catch {
			throw new Error('Failed to decrypt SMTP credentials');
		}
	}
};

export default smtpSecretUtils;
