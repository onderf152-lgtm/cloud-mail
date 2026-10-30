import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/service/aliyun-smtp.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		sendAliyunSmtp: vi.fn(async (env, params, { smtp } = {}) => {
			// Real normalizeSmtpSendOptions: AUTH / mailFrom / identity checks.
			const opts = actual.normalizeSmtpSendOptions(env, params, smtp);
			return {
				id: `<msg@${opts.accountEmail.split('@')[1]}>`,
				_normalized: opts,
				_params: params,
				_smtp: smtp,
			};
		}),
	};
});

import emailService from '../../src/service/email-service.js';
import { sendAliyunSmtp } from '../../src/service/aliyun-smtp.js';
import { resolveDomainSmtpCred } from '../../src/utils/aliyun-smtp-auth.js';
import BizError from '../../src/error/biz-error.js';

const domainEnv = {
	ALIYUN_SMTP_DOMAIN: 'corp.example.com',
	ALIYUN_DOMAIN_SMTP_PASSWORD: 'DomainPass12ab',
	ALIYUN_SMTP_HOST: 'smtpdm-ap-southeast-1.aliyuncs.com',
	ALIYUN_SMTP_PORT: '465',
};

async function drain(gen) {
	const items = [];
	for await (const item of gen) {
		items.push(item);
	}
	return items;
}

function baseSendParams(accountEmail = '1@corp.example.com') {
	return {
		accountEmail,
		domainList: ['@corp.example.com'],
		receiveEmail: ['friend@gmail.com'],
		name: 'User One',
		subject: 'Hello',
		text: 'body',
		html: '<p>body</p>',
		attachments: [],
		sendType: '',
		messageId: null,
	};
}

describe('emailService.sendAliyun (call-chain gate)', () => {
	const c = { env: domainEnv };

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(emailService, 'saveSentEmail').mockResolvedValue({
			emailId: 99,
			recipient: JSON.stringify(['friend@gmail.com']),
		});
	});

	it('accepts DomainAuth creds that only have authUser + password (no .user)', async () => {
		const aliyunSmtpCred = resolveDomainSmtpCred(domainEnv, '1@corp.example.com');
		expect(aliyunSmtpCred.user).toBeUndefined();
		expect(aliyunSmtpCred.authUser).toBe('corp.example.com');

		const items = await drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams('1@corp.example.com'),
			saveParams: { accountId: 1, userId: 2 },
			aliyunSmtpCred,
		}));

		expect(sendAliyunSmtp).toHaveBeenCalledTimes(1);
		const [, params, opts] = sendAliyunSmtp.mock.calls[0];
		expect(opts.smtp.authUser).toBe('corp.example.com');
		expect(opts.smtp.password).toBe('DomainPass12ab');
		expect(opts.smtp.user).toBeUndefined();
		expect(params.accountEmail).toBe('1@corp.example.com');

		const result = await sendAliyunSmtp.mock.results[0].value;
		expect(result._normalized.authMode).toBe('domain');
		expect(result._normalized.authUser).toBe('corp.example.com');
		expect(result._normalized.accountEmail).toBe('1@corp.example.com');
		expect(items[0].emails[0].emailId).toBe(99);
	});

	it('accepts address-mode creds with user + password', async () => {
		const aliyunSmtpCred = {
			authMode: 'address',
			host: 'smtpdm-ap-southeast-1.aliyuncs.com',
			port: 465,
			user: '1@corp.example.com',
			password: 'addr-secret',
		};

		await drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams('1@corp.example.com'),
			saveParams: { accountId: 1, userId: 2 },
			aliyunSmtpCred,
		}));

		expect(sendAliyunSmtp).toHaveBeenCalledTimes(1);
		const result = await sendAliyunSmtp.mock.results[0].value;
		expect(result._normalized.authMode).toBe('address');
		expect(result._normalized.authUser).toBe('1@corp.example.com');
		expect(result._normalized.accountEmail).toBe('1@corp.example.com');
	});

	it('rejects missing auth identity (no authUser and no user)', async () => {
		await expect(drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams(),
			saveParams: {},
			aliyunSmtpCred: { password: 'only-pass', host: 'smtpdm.aliyuncs.com', port: 465 },
		}))).rejects.toBeInstanceOf(BizError);

		expect(sendAliyunSmtp).not.toHaveBeenCalled();
	});

	it('rejects missing password even when authUser is present', async () => {
		await expect(drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams(),
			saveParams: {},
			aliyunSmtpCred: { authMode: 'domain', authUser: 'corp.example.com', password: '' },
		}))).rejects.toBeInstanceOf(BizError);

		expect(sendAliyunSmtp).not.toHaveBeenCalled();
	});

	it('rejects null / undefined credentials (no CF/Resend/no-reply fallback)', async () => {
		await expect(drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams(),
			saveParams: {},
			aliyunSmtpCred: null,
		}))).rejects.toBeInstanceOf(BizError);

		await expect(drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams(),
			saveParams: {},
			aliyunSmtpCred: undefined,
		}))).rejects.toBeInstanceOf(BizError);

		expect(sendAliyunSmtp).not.toHaveBeenCalled();
	});

	it('DomainAuth: From / identity always current account.email (not AUTH domain)', async () => {
		const aliyunSmtpCred = resolveDomainSmtpCred(domainEnv, '1@corp.example.com');

		await drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams('1@corp.example.com'),
			saveParams: {},
			aliyunSmtpCred,
		}));

		const result = await sendAliyunSmtp.mock.results[0].value;
		expect(result._normalized.accountEmail).toBe('1@corp.example.com');
		expect(result._normalized.authUser).toBe('corp.example.com');
		expect(result._params.accountEmail).toBe('1@corp.example.com');
		// MAIL FROM / MIME From come from accountEmail in sendAliyunSmtp
		expect(result._normalized.accountEmail).not.toBe(result._normalized.authUser);
	});

	it('rejects DomainAuth impersonation via mismatched mailFrom', async () => {
		const aliyunSmtpCred = {
			...resolveDomainSmtpCred(domainEnv, '1@corp.example.com'),
			mailFrom: '2@corp.example.com',
		};

		await expect(drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams('1@corp.example.com'),
			saveParams: {},
			aliyunSmtpCred,
		}))).rejects.toThrow(/mailFrom must match account email/);
	});

	it('rejects DomainAuth when account domain differs from AUTH domain', async () => {
		await expect(drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams('1@other.example.com'),
			saveParams: {},
			aliyunSmtpCred: {
				authMode: 'domain',
				authUser: 'corp.example.com',
				password: 'DomainPass12ab',
				host: 'smtpdm-ap-southeast-1.aliyuncs.com',
				port: 465,
				mailFrom: '1@other.example.com',
			},
		}))).rejects.toThrow(/does not match DomainAuth AUTH domain/);
	});

	it('does not fall back to legacy global no-reply when DomainAuth password missing at resolve', () => {
		expect(() => resolveDomainSmtpCred({
			ALIYUN_SMTP_DOMAIN: 'corp.example.com',
			ALIYUN_SMTP_HOST: 'smtpdm-ap-southeast-1.aliyuncs.com',
			ALIYUN_SMTP_USER: 'no-reply@corp.example.com',
			ALIYUN_SMTP_PASSWORD: 'legacy-global',
		}, '1@corp.example.com')).toThrow(/ALIYUN_DOMAIN_SMTP_PASSWORD/);
	});

	it('rejects address-mode when SMTP user != account.email (impersonation)', async () => {
		await expect(drain(emailService.sendAliyun(c, {
			separate: false,
			sendParams: baseSendParams('1@corp.example.com'),
			saveParams: {},
			aliyunSmtpCred: {
				authMode: 'address',
				user: '2@corp.example.com',
				password: 'x',
				host: 'smtpdm-ap-southeast-1.aliyuncs.com',
				port: 465,
			},
		}))).rejects.toThrow(/SMTP user must match account email/);
	});
});
