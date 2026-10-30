import { describe, it, expect, vi } from 'vitest';
import { sendAliyunSmtp, SmtpConnection } from '../../src/service/aliyun-smtp.js';
import { b64Utf8 } from '../../src/service/aliyun-smtp-message.js';

function linesToChunks(lines) {
	const text = lines.map(l => (l.endsWith('\n') ? l : `${l}\r\n`)).join('');
	return new TextEncoder().encode(text);
}

function createMockSocket(script) {
	const queue = [...script];
	let pending = linesToChunks(queue.shift() || ['220 mock ESMTP']);
	const reads = [];
	const written = [];

	const readable = new ReadableStream({
		pull(controller) {
			if (pending.byteLength) {
				controller.enqueue(pending);
				pending = new Uint8Array();
				return;
			}
			return new Promise(resolve => {
				reads.push({ controller, resolve });
			});
		},
		cancel() {
			reads.splice(0).forEach(r => r.resolve());
		}
	});

	const writable = new WritableStream({
		write(chunk) {
			written.push(new TextDecoder().decode(chunk));
			const next = queue.shift();
			if (next) {
				pending = linesToChunks(Array.isArray(next) ? next : [next]);
				const waiter = reads.shift();
				if (waiter) {
					waiter.controller.enqueue(pending);
					pending = new Uint8Array();
					waiter.resolve();
				}
			}
		},
		close() {}
	});

	return {
		readable,
		writable,
		opened: Promise.resolve(),
		close: vi.fn(async () => {}),
		_written: written
	};
}

const baseEnv = {
	ALIYUN_SMTP_HOST: 'smtpdm.aliyuncs.com',
	ALIYUN_SMTP_PORT: '465'
	// no global USER/PASSWORD/REPLY_TO — multi-account must not use them
};

const accountSmtp = {
	host: 'smtpdm.aliyuncs.com',
	port: 465,
	user: 'admin@corp.example.com',
	password: 'per-account-secret'
};

const baseParams = {
	accountEmail: 'admin@corp.example.com',
	domainList: ['@corp.example.com'],
	receiveEmail: ['friend@gmail.com'],
	name: 'Admin',
	subject: 'Test',
	text: 'hello',
	html: '<p>hello</p>',
	attachments: [],
	sendType: '',
	messageId: null
};

const successScript = [
	['220 ready'],
	['250-OK', '250 AUTH'],
	['334 VXNlcm5hbWU6'],
	['334 UGFzc3dvcmQ6'],
	['235 Authentication successful'],
	['250 Mail Ok'],
	['250 Rcpt Ok'],
	['354 End data'],
	['250 Queued'],
	['221 Bye']
];

describe('sendAliyunSmtp multi-account', () => {
	it('sends with per-account credentials; From/AUTH equal account email', async () => {
		const socket = createMockSocket(successScript);
		const result = await sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => socket,
			timeoutMs: 5000,
			smtp: accountSmtp
		});
		expect(result.id).toMatch(/^<.+@corp\.example\.com>$/);
		const transcript = socket._written.join('');
		expect(transcript).toContain(b64Utf8(accountSmtp.user));
		expect(transcript).toContain(`MAIL FROM:<${accountSmtp.user}>`);
		expect(transcript).toContain('From:');
		expect(transcript).toContain(`<${accountSmtp.user}>`);
		expect(transcript).toContain(`Reply-To: <${accountSmtp.user}>`);
		expect(transcript).not.toContain(accountSmtp.password);
		expect(transcript).toContain('QUIT');
	});

	it('rejects when smtp credentials are missing (no global fallback)', async () => {
		await expect(sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => createMockSocket(successScript)
		})).rejects.toThrow('Invalid Aliyun SMTP configuration');
	});

	it('rejects when SMTP user does not match account email (no impersonation)', async () => {
		await expect(sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => createMockSocket(successScript),
			smtp: { ...accountSmtp, user: 'noreply@notify.corp.example.com' }
		})).rejects.toThrow('SMTP user must match account email');
	});

	it('supports a second mailbox with its own identity', async () => {
		const socket = createMockSocket(successScript);
		const user = '1@corp.example.com';
		await sendAliyunSmtp(baseEnv, {
			...baseParams,
			accountEmail: user
		}, {
			connectFn: () => socket,
			timeoutMs: 5000,
			smtp: { ...accountSmtp, user, password: 'mailbox-1-pass' }
		});
		const transcript = socket._written.join('');
		expect(transcript).toContain(`MAIL FROM:<${user}>`);
		expect(transcript).toContain(`Reply-To: <${user}>`);
		expect(transcript).not.toContain('admin@corp.example.com');
		expect(transcript).not.toContain('mailbox-1-pass');
	});

	it('surfaces SMTP auth failure without leaking password', async () => {
		const script = [
			['220 ready'],
			['250-OK', '250 AUTH'],
			['334 VXNlcm5hbWU6'],
			['334 UGFzc3dvcmQ6'],
			['535 Auth failed']
		];
		const socket = createMockSocket(script);
		await expect(sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => socket,
			timeoutMs: 5000,
			smtp: accountSmtp
		})).rejects.toThrow('SMTP command rejected (535)');
		expect(socket._written.join('')).not.toContain(accountSmtp.password);
	});

	it('times out when server never responds', async () => {
		const socket = {
			readable: new ReadableStream({
				pull() {
					return new Promise(() => {});
				}
			}),
			writable: new WritableStream({ write() {} }),
			opened: Promise.resolve(),
			close: vi.fn(async () => {})
		};
		await expect(sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => socket,
			timeoutMs: 50,
			smtp: accountSmtp
		})).rejects.toThrow(/timed out/);
	});

	it('includes attachments and reply headers', async () => {
		const socket = createMockSocket(successScript);
		await sendAliyunSmtp(baseEnv, {
			...baseParams,
			sendType: 'reply',
			messageId: '<orig@mail.example.com>',
			attachments: [{
				filename: 'a.txt',
				contentType: 'text/plain',
				content: btoa('file')
			}, {
				filename: 'embed.png',
				contentType: 'image/png',
				contentId: 'cid1',
				content: btoa('png')
			}]
		}, { connectFn: () => socket, timeoutMs: 5000, smtp: accountSmtp });
		const transcript = socket._written.join('');
		expect(transcript).toContain('multipart/mixed');
		expect(transcript).toContain('Content-ID: <cid1>');
		expect(transcript).toContain('In-Reply-To: <orig@mail.example.com>');
	});
});

describe('sendAliyunSmtp DomainAuth', () => {
	const domainSmtp = {
		authMode: 'domain',
		host: 'smtpdm-ap-southeast-1.aliyuncs.com',
		port: 465,
		authUser: 'corp.example.com',
		password: 'DomainPass12ab',
	};

	it('AUTH uses domain; MAIL FROM / From / Reply-To use account email', async () => {
		const socket = createMockSocket(successScript);
		await sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => socket,
			timeoutMs: 5000,
			smtp: domainSmtp,
		});
		const transcript = socket._written.join('');
		expect(transcript).toContain(b64Utf8('corp.example.com'));
		expect(transcript).toContain('MAIL FROM:<admin@corp.example.com>');
		expect(transcript).toContain('Reply-To: <admin@corp.example.com>');
		expect(transcript).toContain('<admin@corp.example.com>');
		expect(transcript).not.toContain(domainSmtp.password);
		expect(transcript).not.toContain(b64Utf8('admin@corp.example.com'));
	});

	it('keeps independent From for mailbox 1@ and 2@ with shared domain password', async () => {
		for (const user of ['1@corp.example.com', '2@corp.example.com']) {
			const socket = createMockSocket(successScript);
			await sendAliyunSmtp(baseEnv, {
				...baseParams,
				accountEmail: user,
			}, {
				connectFn: () => socket,
				timeoutMs: 5000,
				smtp: domainSmtp,
			});
			const transcript = socket._written.join('');
			expect(transcript).toContain(b64Utf8('corp.example.com'));
			expect(transcript).toContain(`MAIL FROM:<${user}>`);
			expect(transcript).toContain(`Reply-To: <${user}>`);
			expect(transcript).not.toContain('admin@corp.example.com');
		}
	});

	it('rejects DomainAuth when AUTH domain mismatches account email', async () => {
		await expect(sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => createMockSocket(successScript),
			smtp: { ...domainSmtp, authUser: 'other.com' },
		})).rejects.toThrow(/does not match DomainAuth AUTH domain/);
	});

	it('rejects cross-mailbox mailFrom spoofing in DomainAuth', async () => {
		await expect(sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => createMockSocket(successScript),
			smtp: { ...domainSmtp, mailFrom: '2@corp.example.com' },
		})).rejects.toThrow(/mailFrom must match account email/);
	});

	it('does not fall back to address-style user when domain mode lacks authUser', async () => {
		await expect(sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => createMockSocket(successScript),
			smtp: { authMode: 'domain', host: domainSmtp.host, port: 465, password: 'x', user: 'admin@corp.example.com' },
		})).rejects.toThrow(/bare sending domain/);
	});
});

describe('SmtpConnection', () => {
	it('rejects unexpected reply codes', async () => {
		const socket = createMockSocket([['550 denied']]);
		const smtp = new SmtpConnection(socket, { timeoutMs: 2000 });
		await expect(smtp.reply([250])).rejects.toThrow('SMTP command rejected (550)');
		await smtp.close();
	});
});
