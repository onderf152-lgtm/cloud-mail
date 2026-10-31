import { describe, it, expect } from 'vitest';
import {
	SMTP_AUTH_MODE,
	getSmtpAuthMode,
	normalizeSendDomain,
	emailLocalDomain,
	resolveDomainSmtpCred,
	hasAliyunSendCred,
} from '../../src/utils/aliyun-smtp-auth.js';

describe('aliyun-smtp-auth', () => {
	it('defaults auth mode to address', () => {
		expect(getSmtpAuthMode({})).toBe(SMTP_AUTH_MODE.ADDRESS);
	});

	it('accepts domain and address modes', () => {
		expect(getSmtpAuthMode({ ALIYUN_SMTP_AUTH_MODE: 'domain' })).toBe(SMTP_AUTH_MODE.DOMAIN);
		expect(getSmtpAuthMode({ ALIYUN_SMTP_AUTH_MODE: 'ADDRESS' })).toBe(SMTP_AUTH_MODE.ADDRESS);
	});

	it('rejects invalid auth mode', () => {
		expect(() => getSmtpAuthMode({ ALIYUN_SMTP_AUTH_MODE: 'mixed' })).toThrow(/Invalid ALIYUN_SMTP_AUTH_MODE/);
	});

	it('normalizes send domain', () => {
		expect(normalizeSendDomain('Corp.Example.com')).toBe('corp.example.com');
		expect(normalizeSendDomain('@corp.example.com')).toBe('corp.example.com');
	});

	it('rejects invalid send domain', () => {
		expect(() => normalizeSendDomain('admin@corp.example.com')).toThrow(/Invalid ALIYUN_SMTP_DOMAIN/);
		expect(() => normalizeSendDomain('')).toThrow(/Invalid ALIYUN_SMTP_DOMAIN/);
	});

	it('resolves domain SMTP creds with AUTH=domain and identity checks', () => {
		const cred = resolveDomainSmtpCred({
			ALIYUN_SMTP_DOMAIN: 'corp.example.com',
			ALIYUN_DOMAIN_SMTP_PASSWORD: 'DomainPass12ab',
			ALIYUN_SMTP_HOST: 'smtpdm-ap-southeast-1.aliyuncs.com',
			ALIYUN_SMTP_PORT: '465',
		}, '1@corp.example.com');
		expect(cred).toEqual({
			authMode: 'domain',
			host: 'smtpdm-ap-southeast-1.aliyuncs.com',
			port: 465,
			authUser: 'corp.example.com',
			password: 'DomainPass12ab',
			mailFrom: '1@corp.example.com',
		});
	});

	it('rejects missing domain password (no no-reply fallback)', () => {
		expect(() => resolveDomainSmtpCred({
			ALIYUN_SMTP_DOMAIN: 'corp.example.com',
			ALIYUN_SMTP_HOST: 'smtpdm-ap-southeast-1.aliyuncs.com',
		}, 'admin@corp.example.com')).toThrow(/ALIYUN_DOMAIN_SMTP_PASSWORD/);
	});

	it('rejects cross-domain mailbox', () => {
		expect(() => resolveDomainSmtpCred({
			ALIYUN_SMTP_DOMAIN: 'corp.example.com',
			ALIYUN_DOMAIN_SMTP_PASSWORD: 'DomainPass12ab',
			ALIYUN_SMTP_HOST: 'smtpdm-ap-southeast-1.aliyuncs.com',
		}, 'admin@other.com')).toThrow(/does not match/);
	});

	it('parses local domain from email', () => {
		expect(emailLocalDomain('Admin@Corp.Example.com')).toBe('corp.example.com');
	});

	it('hasAliyunSendCred accepts domain authUser+password and address user+password', () => {
		expect(hasAliyunSendCred({ authUser: 'corp.example.com', password: 'x' })).toBe(true);
		expect(hasAliyunSendCred({ user: '1@corp.example.com', password: 'x' })).toBe(true);
		expect(hasAliyunSendCred({ authUser: 'corp.example.com', password: '' })).toBe(false);
		expect(hasAliyunSendCred({ password: 'x' })).toBe(false);
		expect(hasAliyunSendCred(null)).toBe(false);
	});
});
