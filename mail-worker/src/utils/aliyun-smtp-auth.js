/**
 * Aliyun DirectMail SMTP auth-mode helpers (pure, unit-testable).
 * Modes are explicit — never auto-fallback between domain and address.
 */

export const SMTP_AUTH_MODE = {
	DOMAIN: 'domain',
	ADDRESS: 'address',
};

/**
 * @param {Record<string, unknown>} env
 * @returns {'domain'|'address'}
 */
export function getSmtpAuthMode(env = {}) {
	const raw = String(env.ALIYUN_SMTP_AUTH_MODE ?? SMTP_AUTH_MODE.ADDRESS).trim().toLowerCase();
	if (raw === SMTP_AUTH_MODE.DOMAIN || raw === SMTP_AUTH_MODE.ADDRESS) {
		return raw;
	}
	throw new Error('Invalid ALIYUN_SMTP_AUTH_MODE (use domain or address)');
}

/**
 * Bare sending domain for DomainAuth AUTH username (e.g. example.com).
 */
export function normalizeSendDomain(value) {
	const domain = String(value || '').trim().toLowerCase().replace(/^@+/, '');
	if (!domain || domain.includes('@') || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
		throw new Error('Invalid ALIYUN_SMTP_DOMAIN');
	}
	return domain;
}

export function emailLocalDomain(email) {
	const parts = String(email || '').trim().toLowerCase().split('@');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error('Invalid email address');
	}
	return parts[1];
}

/**
 * Build DomainAuth SMTP send credentials from Worker secrets.
 * AUTH user = sending domain; identity (MAIL FROM) stays accountEmail (caller).
 */
export function resolveDomainSmtpCred(env, accountEmail) {
	const sendDomain = normalizeSendDomain(env.ALIYUN_SMTP_DOMAIN);
	const password = String(env.ALIYUN_DOMAIN_SMTP_PASSWORD || '');
	if (!password) {
		throw new Error('ALIYUN_DOMAIN_SMTP_PASSWORD is missing');
	}
	const host = String(env.ALIYUN_SMTP_HOST || '').trim();
	const port = Number(env.ALIYUN_SMTP_PORT || 465);
	if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
		throw new Error('Invalid Aliyun SMTP host');
	}
	if (port !== 465) {
		throw new Error('Invalid Aliyun SMTP port');
	}
	const email = String(accountEmail || '').trim();
	const accountDomain = emailLocalDomain(email);
	if (accountDomain !== sendDomain) {
		throw new Error('Account email domain does not match ALIYUN_SMTP_DOMAIN');
	}
	return {
		authMode: SMTP_AUTH_MODE.DOMAIN,
		host,
		port,
		authUser: sendDomain,
		password,
		mailFrom: email,
	};
}

/**
 * Gate for email-service.sendAliyun().
 * domain mode: authUser (bare domain) + password
 * address mode: user (mailbox) + password
 * Never treats missing identity as “use no-reply / CF / Resend”.
 */
export function hasAliyunSendCred(cred) {
	if (!cred || !String(cred.password || '')) {
		return false;
	}
	const identity = String(cred.authUser || cred.user || '').trim();
	return Boolean(identity);
}
