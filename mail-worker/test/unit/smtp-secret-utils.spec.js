import { describe, it, expect } from 'vitest';
import smtpSecretUtils from '../../src/utils/smtp-secret-utils.js';

const env = {
	SMTP_CREDENTIALS_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
};

describe('smtp-secret-utils', () => {
	it('encrypts and decrypts SMTP password for the same accountId', async () => {
		const { passCipher, passIv, keyVer } = await smtpSecretUtils.encryptPassword(env, 7, 'Aliyun-Smtp-Pass!');
		expect(passCipher).toBeTruthy();
		expect(passIv).toBeTruthy();
		expect(passCipher).not.toContain('Aliyun-Smtp-Pass!');
		const plain = await smtpSecretUtils.decryptPassword(env, 7, passCipher, passIv, keyVer);
		expect(plain).toBe('Aliyun-Smtp-Pass!');
	});

	it('binds ciphertext to accountId (AAD) so another account cannot decrypt', async () => {
		const { passCipher, passIv, keyVer } = await smtpSecretUtils.encryptPassword(env, 1, 'secret-one');
		await expect(
			smtpSecretUtils.decryptPassword(env, 2, passCipher, passIv, keyVer)
		).rejects.toThrow('Failed to decrypt SMTP credentials');
	});

	it('fails closed when master key is missing', async () => {
		await expect(
			smtpSecretUtils.encryptPassword({}, 1, 'x')
		).rejects.toThrow('SMTP_CREDENTIALS_KEY is missing');
	});

	it('rejects weak passphrase master keys (no SHA-256 fallback)', async () => {
		await expect(
			smtpSecretUtils.encryptPassword({ SMTP_CREDENTIALS_KEY: 'short-password' }, 1, 'x')
		).rejects.toThrow(/64 hex chars or base64 of 32 bytes/);
	});

	it('accepts base64-encoded 32-byte master key', async () => {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		let binary = '';
		for (const b of bytes) binary += String.fromCharCode(b);
		const key = btoa(binary);
		const localEnv = { SMTP_CREDENTIALS_KEY: key };
		const { passCipher, passIv, keyVer } = await smtpSecretUtils.encryptPassword(localEnv, 9, 'pass');
		expect(await smtpSecretUtils.decryptPassword(localEnv, 9, passCipher, passIv, keyVer)).toBe('pass');
	});

	it('rejects empty password', async () => {
		await expect(
			smtpSecretUtils.encryptPassword(env, 1, '')
		).rejects.toThrow('SMTP password is empty');
	});

	it('uses independent IVs for each encryption', async () => {
		const a = await smtpSecretUtils.encryptPassword(env, 3, 'same-pass');
		const b = await smtpSecretUtils.encryptPassword(env, 3, 'same-pass');
		expect(a.passIv).not.toBe(b.passIv);
		expect(a.passCipher).not.toBe(b.passCipher);
	});
});
