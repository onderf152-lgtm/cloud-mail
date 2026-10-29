import { describe, it, expect } from 'vitest';
import { splitRecipientsByDomain } from '../../src/service/aliyun-smtp-message.js';

/**
 * Mirrors email-service send() routing gates for Aliyun admin-only + provider checks.
 * Keeps permission logic testable without D1 / Workers bindings.
 */
function canUseAliyunSMTP({ accountEmail, admin, env }) {
	return Boolean(
		String(accountEmail || '').toLowerCase() === String(admin || '').toLowerCase() &&
		env.ALIYUN_SMTP_HOST &&
		env.ALIYUN_SMTP_PORT &&
		env.ALIYUN_SMTP_USER &&
		env.ALIYUN_SMTP_PASSWORD &&
		env.ALIYUN_REPLY_TO
	);
}

function assertExternalProvider({
	receiveEmail,
	domainList,
	accountEmail,
	admin,
	env,
	useCloudflareEmail,
	resendToken,
	roleSendType,
	isAdminUser
}) {
	const { internal, external } = splitRecipientsByDomain(receiveEmail, domainList);
	const allInternal = external.length === 0;
	const hasExternal = external.length > 0;
	const useAliyunSMTP = canUseAliyunSMTP({ accountEmail, admin, env });

	if (!isAdminUser) {
		if (roleSendType === 'ban') {
			throw new Error('bannedSend');
		}
		if (roleSendType === 'internal' && !allInternal) {
			throw new Error('onlyInternalSend');
		}
	}

	if (hasExternal && !useAliyunSMTP && !useCloudflareEmail && !resendToken) {
		throw new Error('noSendProvider');
	}

	return { internal, external, useAliyunSMTP, allInternal };
}

const aliyunEnv = {
	ALIYUN_SMTP_HOST: 'smtpdm.aliyun.com',
	ALIYUN_SMTP_PORT: '465',
	ALIYUN_SMTP_USER: 'noreply@dm.example.com',
	ALIYUN_SMTP_PASSWORD: 'x',
	ALIYUN_REPLY_TO: 'admin@corp.example.com'
};

describe('email send routing (Aliyun phase-1)', () => {
	it('allows admin + aliyun for external recipients', () => {
		const result = assertExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: 'admin@corp.example.com',
			admin: 'admin@corp.example.com',
			env: aliyunEnv,
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: true
		});
		expect(result.useAliyunSMTP).toBe(true);
		expect(result.external).toEqual(['a@gmail.com']);
	});

	it('blocks non-admin account from Aliyun even if secrets exist', () => {
		expect(() => assertExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: 'user@corp.example.com',
			admin: 'admin@corp.example.com',
			env: aliyunEnv,
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: false
		})).toThrow('noSendProvider');
	});

	it('blocks role sendType=internal when any recipient is external', () => {
		expect(() => assertExternalProvider({
			receiveEmail: ['a@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: 'user@corp.example.com',
			admin: 'admin@corp.example.com',
			env: aliyunEnv,
			useCloudflareEmail: true,
			resendToken: null,
			roleSendType: 'internal',
			isAdminUser: false
		})).toThrow('onlyInternalSend');
	});

	it('splits mixed recipients so internal are not treated as external-only', () => {
		const result = assertExternalProvider({
			receiveEmail: ['in@corp.example.com', 'out@gmail.com'],
			domainList: ['@corp.example.com'],
			accountEmail: 'admin@corp.example.com',
			admin: 'admin@corp.example.com',
			env: aliyunEnv,
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'count',
			isAdminUser: true
		});
		expect(result.internal).toEqual(['in@corp.example.com']);
		expect(result.external).toEqual(['out@gmail.com']);
		expect(result.allInternal).toBe(false);
		expect(result.useAliyunSMTP).toBe(true);
	});

	it('allows all-internal without external provider', () => {
		const result = assertExternalProvider({
			receiveEmail: ['in@corp.example.com'],
			domainList: ['@corp.example.com'],
			accountEmail: 'user@corp.example.com',
			admin: 'admin@corp.example.com',
			env: {},
			useCloudflareEmail: false,
			resendToken: null,
			roleSendType: 'internal',
			isAdminUser: false
		});
		expect(result.allInternal).toBe(true);
		expect(result.external).toEqual([]);
	});
});
