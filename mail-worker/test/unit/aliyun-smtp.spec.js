import { describe, it, expect, vi } from 'vitest';
import { sendAliyunSmtp, SmtpConnection } from '../../src/service/aliyun-smtp.js';
import { b64Utf8 } from '../../src/service/aliyun-smtp-message.js';

function linesToChunks(lines) {
	const text = lines.map(l => (l.endsWith('\n') ? l : `${l}\r\n`)).join('');
	return new TextEncoder().encode(text);
}

/**
 * Minimal mock TCP socket that speaks a scripted SMTP server.
 * `script` is an array of server response blocks pushed after each client write (plus greeting on open).
 */
function createMockSocket(script) {
	const queue = [...script];
	let pending = linesToChunks(queue.shift() || ['220 mock ESMTP']);
	const reads = [];
	let writeCount = 0;
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
			writeCount++;
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
		_written: written,
		_writeCount: () => writeCount
	};
}

const baseEnv = {
	ALIYUN_SMTP_HOST: 'smtpdm.aliyun.com',
	ALIYUN_SMTP_PORT: '465',
	ALIYUN_SMTP_USER: 'noreply@dm.example.com',
	ALIYUN_SMTP_PASSWORD: 'smtp-secret',
	ALIYUN_REPLY_TO: 'admin@corp.example.com'
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

describe('sendAliyunSmtp', () => {
	it('sends successfully with mocked socket and returns message id', async () => {
		const socket = createMockSocket(successScript);
		const result = await sendAliyunSmtp(baseEnv, baseParams, {
			connectFn: () => socket,
			timeoutMs: 5000
		});
		expect(result.id).toMatch(/^<.+@dm\.example\.com>$/);
		const transcript = socket._written.join('');
		expect(transcript).toContain('AUTH LOGIN');
		expect(transcript).toContain(b64Utf8(baseEnv.ALIYUN_SMTP_USER));
		expect(transcript).toContain(`MAIL FROM:<${baseEnv.ALIYUN_SMTP_USER}>`);
		expect(transcript).toContain('RCPT TO:<friend@gmail.com>');
		expect(transcript).toContain('DATA');
		expect(transcript).not.toContain(baseEnv.ALIYUN_SMTP_PASSWORD);
		expect(transcript).toContain('QUIT');
	});

	it('rejects invalid SMTP configuration', async () => {
		await expect(sendAliyunSmtp({
			...baseEnv,
			ALIYUN_SMTP_PORT: '587'
		}, baseParams, { connectFn: () => createMockSocket(successScript) }))
			.rejects.toThrow('Invalid Aliyun SMTP configuration');
	});

	it('fails closed when Reply-To policy does not match', async () => {
		await expect(sendAliyunSmtp(baseEnv, {
			...baseParams,
			accountEmail: 'other@corp.example.com'
		}, { connectFn: () => createMockSocket(successScript) }))
			.rejects.toThrow('Reply-To must match the verified Aliyun reply address');
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
			timeoutMs: 5000
		})).rejects.toThrow('SMTP command rejected (535)');
		expect(socket._written.join('')).not.toContain(baseEnv.ALIYUN_SMTP_PASSWORD);
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
			timeoutMs: 50
		})).rejects.toThrow(/timed out/);
	});

	it('sends with attachment payload in DATA', async () => {
		const socket = createMockSocket(successScript);
		await sendAliyunSmtp(baseEnv, {
			...baseParams,
			attachments: [{
				filename: 'a.txt',
				contentType: 'text/plain',
				content: btoa('file')
			}]
		}, { connectFn: () => socket, timeoutMs: 5000 });
		const transcript = socket._written.join('');
		expect(transcript).toContain('multipart/mixed');
		expect(transcript).toContain('filename="a.txt"');
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
