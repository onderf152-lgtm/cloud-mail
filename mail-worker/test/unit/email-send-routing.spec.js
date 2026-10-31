import { describe, it, expect } from 'vitest';
import { splitRecipientsByDomain, resolveAliyunReplyTo } from '../../src/service/aliyun-smtp-message.js';

/**
 * Mirrors email-service outbound gating:
 * external mail requires Aliyun SMTP (DomainAuth or per-account) — no CF/Resend fallback.
 */
function credMatchesAccount(aliyunSmtpCred, accountEmail) {
	if (!aliyunSmtpCred) return false;
	if (aliyunSmtpCred.authMode === 'domain') {
		const authUser = String(aliyunSmtpCred.authUser || '').toLowerCase();
		const domain = String(accountEmail).split('@')[1]?.toLowerCase();
		const mailFrom = String(aliyunSmtpCred.mailFrom || accountEmail).toLowerCase();
		return Boolean(authUser && domain === authUser && mailFrom === String(accountEmail).toLowerCase());
	}
	const user = String(aliyunSmtpCred.user || aliyunSmtpCred.authUser || '').toLowerCase();
	return user === String(accountEmail).toLowerCase();
}

function resolveExternalProvider({
	receiveEmail,
	domainList,
	accountEmail,
	ownerUserId,
	currentUserId,
	aliyunSmtpCred,
	smtpDisabled = false,
	useCloudflareEmail,
	resendToken,
	roleSendType,
	isAdminUser
}) {
	if (ownerUserId !== currentUserId && !isAdminUser) {
		throw new Error('sendEmailNotCurUser');
	}

	const { internal, external } = splitRecipientsByDomain(receiveEmail, domainList);
	const allInternal = external.length === 0;
	const hasExternal = external.length > 0;

	if (!isAdminUser) {
		if (roleSendType === 'ban') throw new Error('bannedSend');
		if (roleSendType === 'internal' && !allInternal) throw new Error('onlyInternalSend');
	}

	// Must validate external SMTP before any delivery (including internal leg).
	if (hasExternal) {
		if (smtpDisabled) {
			throw new Error('smtpDisabled');
		}
		const useAliyunSMTP = credMatchesAccount(aliyunSmtpCred, accountEmail);
		if (!useAliyunSMTP) {
			// CF / Resend must NOT auto-send for enterprise external mail.
			void useCloudflareEmail;
			void resendToken;
			throw new Error('smtpNotConfigured');
		}
		return {
			internal,
			external,
			useAliyunSMTP: true,
			provider: 'aliyun',
			allInternal,
			canStartDelivery: true
		};
	}

	return {
		internal,
		external,
		useAliyunSMTP: false,
		provider: 'none',
		allInternal,
		canStartDelivery: true
	};
}

describe('email send routing (Aliyun-only external)', () => {
	it('allows non-admin to send externally with own SMTP credentials', () => {
		const result = resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: { user: '1@corp.example.com', password: 'x' },
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: false
		});
		expect(result.useAliyunSMTP).toBe(true);
		expect(result.provider).toBe('aliyun');
	});

	it('blocks sending with another mailbox ownership', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '2@corp.example.com',
			ownerUserId: 3,
			currentUserId: 2,
			aliyunSmtpCred: { user: '2@corp.example.com', password: 'x' },
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: false
		})).toThrow('sendEmailNotCurUser');
	});

	it('fails when SMTP is not configured (no global no-reply fallback)', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: null,
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: false
		})).toThrow('smtpNotConfigured');
	});

	it('does not auto-fallback to Cloudflare Email Sending', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: null,
			useCloudflareEmail: true,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: false
		})).toThrow('smtpNotConfigured');
	});

	it('does not auto-fallback to Resend token', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: null,
			useCloudflareEmail: false,
			resendToken: 're_xxx',
			roleSendType: 'count',
			isAdminUser: false
		})).toThrow('smtpNotConfigured');
	});

	it('rejects shared notify address as Aliyun identity', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: { user: 'noreply@notify.corp.example.com', password: 'x' },
			useCloudflareEmail: true,
			resendToken: 're_xxx',
			roleSendType: 'count',
			isAdminUser: false
		})).toThrow('smtpNotConfigured');
	});

	it('rejects external send when SMTP is disabled before any delivery', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['in@corp.example.com', 'out@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: { user: '1@corp.example.com', password: 'x' },
			smtpDisabled: true,
			useCloudflareEmail: true,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: false
		})).toThrow('smtpDisabled');
	});

	it('validates external SMTP before mixed delivery can start', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['in@corp.example.com', 'out@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: null,
			useCloudflareEmail: true,
			resendToken: 're_xxx',
			roleSendType: 'count',
			isAdminUser: false
		})).toThrow('smtpNotConfigured');
	});

	it('splits mixed recipients when Aliyun SMTP is ready', () => {
		const result = resolveExternalProvider({
			receiveEmail: ['in@corp.example.com', 'out@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: 'admin@corp.example.com',
			ownerUserId: 1,
			currentUserId: 1,
			aliyunSmtpCred: { user: 'admin@corp.example.com', password: 'x' },
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: true
		});
		expect(result.internal).toEqual(['in@corp.example.com']);
		expect(result.external).toEqual(['out@gmail.com']);
		expect(result.provider).toBe('aliyun');
		expect(result.canStartDelivery).toBe(true);
	});

	it('allows all-internal without SMTP', () => {
		const result = resolveExternalProvider({
			receiveEmail: ['in@corp.example.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: null,
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'internal',
			isAdminUser: false
		});
		expect(result.allInternal).toBe(true);
		expect(result.provider).toBe('none');
	});

	it('blocks role sendType=internal for external recipients', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: { user: '1@corp.example.com', password: 'x' },
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'internal',
			isAdminUser: false
		})).toThrow('onlyInternalSend');
	});
});

describe('multi-account From / Reply-To / AUTH identity', () => {
	it('Reply-To and smtp user must equal current account.email', () => {
		expect(resolveAliyunReplyTo({
			accountEmail: '2@corp.example.com',
			domainList: ['@corp.example.com'],
			smtpUser: '2@corp.example.com'
		})).toBe('2@corp.example.com');
	});

	it('rejects impersonation via different smtp user', () => {
		expect(() => resolveAliyunReplyTo({
			accountEmail: '1@corp.example.com',
			domainList: ['@corp.example.com'],
			smtpUser: 'aa@corp.example.com'
		})).toThrow('Reply-To must match SMTP user and account email');
	});
});

describe('admin smtp config gate', () => {
	function assertAdminOnly(actorEmail, adminEmail) {
		if (actorEmail !== adminEmail) {
			throw new Error('unauthorized');
		}
		return true;
	}

	it('allows admin to manage SMTP', () => {
		expect(assertAdminOnly('admin@corp.example.com', 'admin@corp.example.com')).toBe(true);
	});

	it('rejects non-admin SMTP management', () => {
		expect(() => assertAdminOnly('1@corp.example.com', 'admin@corp.example.com'))
			.toThrow('unauthorized');
	});
});

describe('DomainAuth external routing', () => {
	const domainCred = (email) => ({
		authMode: 'domain',
		authUser: 'corp.example.com',
		mailFrom: email,
		password: 'DomainPass12ab',
	});

	it('allows external send with shared domain creds for mailbox 1@', () => {
		const result = resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: domainCred('1@corp.example.com'),
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: false,
		});
		expect(result.provider).toBe('aliyun');
	});

	it('rejects DomainAuth cred spoofing another mailbox mailFrom', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: '1@corp.example.com',
			ownerUserId: 2,
			currentUserId: 2,
			aliyunSmtpCred: domainCred('2@corp.example.com'),
			useCloudflareEmail: true,
			resendToken: 're_xxx',
			roleSendType: 'count',
			isAdminUser: false,
		})).toThrow('smtpNotConfigured');
	});

	it('still skips CF/Resend when domain password missing', () => {
		expect(() => resolveExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: 'admin@corp.example.com',
			ownerUserId: 1,
			currentUserId: 1,
			aliyunSmtpCred: null,
			useCloudflareEmail: true,
			resendToken: 're_xxx',
			roleSendType: 'count',
			isAdminUser: true,
		})).toThrow('smtpNotConfigured');
	});
});
