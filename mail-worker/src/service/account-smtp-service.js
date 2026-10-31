import orm from '../entity/orm';
import accountSmtp, { accountSmtpConst } from '../entity/account-smtp';
import account from '../entity/account';
import { eq, inArray, and } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import smtpSecretUtils from '../utils/smtp-secret-utils';
import emailUtils from '../utils/email-utils';
import userService from './user-service';
import { isDel } from '../const/entity-const';
import dayjs from 'dayjs';
import {
	SMTP_AUTH_MODE,
	getSmtpAuthMode,
	resolveDomainSmtpCred,
} from '../utils/aliyun-smtp-auth';

function assertAdmin(c, userId) {
	return userService.selectById(c, userId).then(userRow => {
		if (!userRow || userRow.email !== c.env.admin) {
			throw new BizError(t('unauthorized'), 403);
		}
		return userRow;
	});
}

function toPublicStatus(row, { authMode = SMTP_AUTH_MODE.ADDRESS } = {}) {
	if (!row) {
		return {
			configured: false,
			status: 0,
			smtpUser: '',
			smtpHost: '',
			smtpPort: 465,
			updatedAt: null,
			authMode,
			domainAuth: authMode === SMTP_AUTH_MODE.DOMAIN,
		};
	}
	return {
		configured: true,
		status: row.status,
		smtpUser: row.smtpUser,
		smtpHost: row.smtpHost || '',
		smtpPort: row.smtpPort || 465,
		updatedAt: row.updatedAt,
		authMode,
		domainAuth: authMode === SMTP_AUTH_MODE.DOMAIN,
	};
}

function domainAuthPublicStatus(c, accountEmail) {
	const host = String(c.env.ALIYUN_SMTP_HOST || '').trim();
	const port = Number(c.env.ALIYUN_SMTP_PORT || 465);
	const configured = Boolean(
		String(c.env.ALIYUN_SMTP_DOMAIN || '').trim() &&
		String(c.env.ALIYUN_DOMAIN_SMTP_PASSWORD || '') &&
		host
	);
	return {
		configured,
		status: configured ? accountSmtpConst.status.ACTIVE : 0,
		smtpUser: accountEmail || '',
		smtpHost: host,
		smtpPort: port || 465,
		updatedAt: null,
		authMode: SMTP_AUTH_MODE.DOMAIN,
		domainAuth: true,
	};
}

const accountSmtpService = {

	getAuthMode(c) {
		try {
			return getSmtpAuthMode(c.env);
		} catch {
			throw new BizError(t('smtpAuthModeInvalid'), 500);
		}
	},

	async getStatus(c, accountId, userId) {
		await assertAdmin(c, userId);
		const accountIdNum = Number(accountId);
		const accountRow = await orm(c).select().from(account).where(eq(account.accountId, accountIdNum)).get();
		if (!accountRow) {
			throw new BizError(t('senderAccountNotExist'));
		}
		const authMode = this.getAuthMode(c);
		if (authMode === SMTP_AUTH_MODE.DOMAIN) {
			return {
				accountId: accountIdNum,
				email: accountRow.email,
				...domainAuthPublicStatus(c, accountRow.email),
			};
		}
		const row = await orm(c).select().from(accountSmtp).where(eq(accountSmtp.accountId, accountIdNum)).get();
		return {
			accountId: accountIdNum,
			email: accountRow.email,
			...toPublicStatus(row, { authMode }),
		};
	},

	async listStatusByAccountIds(c, accountIds = []) {
		const ids = accountIds.map(Number).filter(Boolean);
		if (!ids.length) return {};
		const authMode = this.getAuthMode(c);
		if (authMode === SMTP_AUTH_MODE.DOMAIN) {
			const accountRows = await orm(c).select().from(account).where(inArray(account.accountId, ids)).all();
			const emailById = Object.fromEntries(accountRows.map(r => [r.accountId, r.email]));
			const map = {};
			for (const id of ids) {
				map[id] = domainAuthPublicStatus(c, emailById[id] || '');
			}
			return map;
		}
		const rows = await orm(c).select().from(accountSmtp).where(inArray(accountSmtp.accountId, ids)).all();
		const map = {};
		for (const id of ids) {
			map[id] = toPublicStatus(null, { authMode });
		}
		for (const row of rows) {
			map[row.accountId] = toPublicStatus(row, { authMode });
		}
		return map;
	},

	async upsert(c, params, userId) {
		await assertAdmin(c, userId);
		if (this.getAuthMode(c) === SMTP_AUTH_MODE.DOMAIN) {
			throw new BizError(t('smtpAddressModeOnly'), 400);
		}
		const accountId = Number(params.accountId);
		const password = String(params.password || '');
		const accountRow = await orm(c).select().from(account).where(
			and(eq(account.accountId, accountId), eq(account.isDel, isDel.NORMAL))
		).get();
		if (!accountRow) {
			throw new BizError(t('senderAccountNotExist'));
		}
		if (!password) {
			throw new BizError(t('smtpPasswordRequired'));
		}
		if (!c.env.SMTP_CREDENTIALS_KEY) {
			throw new BizError(t('smtpMasterKeyMissing'), 500);
		}
		const domains = typeof c.env.domain === 'string'
			? (() => { try { return JSON.parse(c.env.domain); } catch { return []; } })()
			: (c.env.domain || []);
		if (!domains.includes(emailUtils.getDomain(accountRow.email))) {
			throw new BizError(t('notExistDomain'));
		}

		const host = String(params.smtpHost || c.env.ALIYUN_SMTP_HOST || '').trim();
		const port = Number(params.smtpPort || c.env.ALIYUN_SMTP_PORT || 465);
		if (port !== 465) {
			throw new BizError(t('smtpPortInvalid'));
		}
		if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
			throw new BizError(t('smtpHostRequired'));
		}

		const { passCipher, passIv, keyVer } = await smtpSecretUtils.encryptPassword(
			c.env,
			accountId,
			password
		);

		const values = {
			accountId,
			smtpHost: host,
			smtpPort: port,
			smtpUser: accountRow.email,
			passCipher,
			passIv,
			keyVer,
			status: accountSmtpConst.status.ACTIVE,
			updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss')
		};

		const existing = await orm(c).select().from(accountSmtp).where(eq(accountSmtp.accountId, accountId)).get();
		if (existing) {
			await orm(c).update(accountSmtp).set(values).where(eq(accountSmtp.accountId, accountId)).run();
		} else {
			await orm(c).insert(accountSmtp).values(values).run();
		}

		return {
			accountId,
			email: accountRow.email,
			...toPublicStatus({ ...values, status: accountSmtpConst.status.ACTIVE })
		};
	},

	async setStatus(c, params, userId) {
		await assertAdmin(c, userId);
		if (this.getAuthMode(c) === SMTP_AUTH_MODE.DOMAIN) {
			throw new BizError(t('smtpAddressModeOnly'), 400);
		}
		const accountId = Number(params.accountId);
		const status = Number(params.status);
		if (![accountSmtpConst.status.ACTIVE, accountSmtpConst.status.DISABLED].includes(status)) {
			throw new BizError(t('smtpStatusInvalid'));
		}
		const existing = await orm(c).select().from(accountSmtp).where(eq(accountSmtp.accountId, accountId)).get();
		if (!existing) {
			throw new BizError(t('smtpNotConfigured'));
		}
		await orm(c).update(accountSmtp).set({
			status,
			updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss')
		}).where(eq(accountSmtp.accountId, accountId)).run();
		return {
			accountId,
			...toPublicStatus({ ...existing, status })
		};
	},

	async revoke(c, params, userId) {
		await assertAdmin(c, userId);
		if (this.getAuthMode(c) === SMTP_AUTH_MODE.DOMAIN) {
			throw new BizError(t('smtpAddressModeOnly'), 400);
		}
		const accountId = Number(params.accountId);
		await orm(c).delete(accountSmtp).where(eq(accountSmtp.accountId, accountId)).run();
		return { accountId, configured: false, status: 0, authMode: SMTP_AUTH_MODE.ADDRESS, domainAuth: false };
	},

	async removeByAccountId(c, accountId) {
		try {
			await orm(c).delete(accountSmtp).where(eq(accountSmtp.accountId, Number(accountId))).run();
		} catch (e) {
			// DomainAuth 部署可能尚未创建 account_smtp；删邮箱不应因此失败。
			const msg = String(e?.message || e);
			if (/no such table|account_smtp/i.test(msg)) {
				console.warn(`跳过 account_smtp 清理：${msg}`);
				return;
			}
			throw e;
		}
	},

	async removeByAccountIds(c, accountIds = []) {
		const ids = accountIds.map(Number).filter(Boolean);
		if (!ids.length) return;
		try {
			await orm(c).delete(accountSmtp).where(inArray(accountSmtp.accountId, ids)).run();
		} catch (e) {
			const msg = String(e?.message || e);
			if (/no such table|account_smtp/i.test(msg)) {
				console.warn(`跳过 account_smtp 批量清理：${msg}`);
				return;
			}
			throw e;
		}
	},

	/**
	 * Resolve SMTP credentials for outbound send.
	 * domain mode: Worker secrets only (no account_smtp row required).
	 * address mode: per-account encrypted row (existing behavior).
	 * Never auto-falls back between modes or to global no-reply / CF / Resend.
	 */
	async tryGetForSend(c, accountId, accountEmail) {
		const authMode = this.getAuthMode(c);

		if (authMode === SMTP_AUTH_MODE.DOMAIN) {
			try {
				return resolveDomainSmtpCred(c.env, accountEmail);
			} catch (err) {
				const msg = err?.message || '';
				if (msg.includes('ALIYUN_DOMAIN_SMTP_PASSWORD')) {
					throw new BizError(t('domainSmtpPasswordMissing'), 500);
				}
				if (msg.includes('ALIYUN_SMTP_DOMAIN') || msg.includes('does not match')) {
					throw new BizError(t('domainSmtpDomainMismatch'));
				}
				if (msg.includes('host') || msg.includes('port')) {
					throw new BizError(t('smtpHostRequired'));
				}
				throw new BizError(t('smtpNotConfigured'));
			}
		}

		const row = await orm(c).select().from(accountSmtp).where(
			eq(accountSmtp.accountId, Number(accountId))
		).get();
		if (!row) {
			return null;
		}
		if (row.status === accountSmtpConst.status.DISABLED) {
			throw new BizError(t('smtpDisabled'));
		}
		if (!c.env.SMTP_CREDENTIALS_KEY) {
			throw new BizError(t('smtpMasterKeyMissing'), 500);
		}
		if (String(row.smtpUser).toLowerCase() !== String(accountEmail).toLowerCase()) {
			throw new BizError(t('smtpUserMismatch'));
		}
		const host = String(row.smtpHost || c.env.ALIYUN_SMTP_HOST || '').trim();
		if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
			throw new BizError(t('smtpHostRequired'));
		}
		let password;
		try {
			password = await smtpSecretUtils.decryptPassword(
				c.env,
				accountId,
				row.passCipher,
				row.passIv,
				row.keyVer
			);
		} catch {
			throw new BizError(t('smtpDecryptFailed'), 500);
		}
		return {
			authMode: SMTP_AUTH_MODE.ADDRESS,
			host,
			port: row.smtpPort || 465,
			user: row.smtpUser,
			authUser: row.smtpUser,
			password,
			mailFrom: accountEmail,
		};
	}
};

export default accountSmtpService;
