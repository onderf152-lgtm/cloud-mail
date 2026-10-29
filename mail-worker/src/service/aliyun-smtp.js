// Cloud Mail -> Alibaba Cloud DirectMail SMTP adapter.
// TCP uses Cloudflare Workers `cloudflare:sockets` (loaded lazily for Node unit tests).
import {
	b64Utf8,
	emailAddress,
	makeAliyunEmail,
	resolveAliyunReplyTo
} from './aliyun-smtp-message';

const encoder = new TextEncoder();
const DEFAULT_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
		})
	]).finally(() => clearTimeout(timer));
}

export class SmtpConnection {
	constructor(socket, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
		this.socket = socket;
		this.timeoutMs = timeoutMs;
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
		this.decoder = new TextDecoder();
		this.buffer = '';
		this.closed = false;
	}

	async reply(expected) {
		let response = '';
		let code = '';
		while (true) {
			const newline = this.buffer.indexOf('\n');
			if (newline < 0) {
				const { value, done } = await withTimeout(
					this.reader.read(),
					this.timeoutMs,
					'SMTP read'
				);
				if (done) throw new Error('SMTP server closed the connection');
				this.buffer += this.decoder.decode(value, { stream: true });
				if (this.buffer.length + response.length > 32768) {
					throw new Error('SMTP response too large');
				}
				continue;
			}
			const line = this.buffer.slice(0, newline).replace(/\r$/, '');
			this.buffer = this.buffer.slice(newline + 1);
			response += `${line}\n`;
			if (!/^\d{3}[ -]/.test(line)) throw new Error('Invalid SMTP response');
			code = line.slice(0, 3);
			if (line[3] === ' ') break;
		}
		if (!expected.includes(Number(code))) {
			// Avoid returning full SMTP replies that may contain private addresses.
			throw new Error(`SMTP command rejected (${code})`);
		}
		return response;
	}

	async command(text, expected) {
		await withTimeout(
			this.writer.write(encoder.encode(`${text}\r\n`)),
			this.timeoutMs,
			'SMTP write'
		);
		return this.reply(expected);
	}

	async data(raw) {
		// SMTP dot-stuffing: double a leading dot on every content line.
		const stuffed = raw.replace(/\r?\n/g, '\r\n').split('\r\n').map(
			line => (line.startsWith('.') ? `.${line}` : line)
		).join('\r\n');
		await withTimeout(
			this.writer.write(encoder.encode(`${stuffed.endsWith('\r\n') ? stuffed : stuffed + '\r\n'}.\r\n`)),
			this.timeoutMs,
			'SMTP data write'
		);
		return this.reply([250]);
	}

	async quit() {
		try {
			await withTimeout(
				this.writer.write(encoder.encode('QUIT\r\n')),
				Math.min(this.timeoutMs, 5000),
				'SMTP QUIT'
			);
			await withTimeout(this.reply([221]), Math.min(this.timeoutMs, 5000), 'SMTP QUIT reply').catch(() => {});
		} catch {
			// Best-effort QUIT; close() still runs.
		}
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.reader.cancel().catch(() => {});
		} catch { /* ignore */ }
		try {
			this.reader.releaseLock();
		} catch { /* ignore */ }
		try {
			await this.writer.close().catch(() => {});
		} catch { /* ignore */ }
		try {
			this.writer.releaseLock();
		} catch { /* ignore */ }
		try {
			await withTimeout(this.socket.close(), 3000, 'SMTP socket close').catch(() => {});
		} catch { /* ignore */ }
	}
}

export async function sendAliyunSmtp(env, params, { connectFn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const host = String(env.ALIYUN_SMTP_HOST || '').trim();
	const port = Number(env.ALIYUN_SMTP_PORT || 465);
	const username = emailAddress(env.ALIYUN_SMTP_USER);
	const password = String(env.ALIYUN_SMTP_PASSWORD || '');
	if (!host || !password || port !== 465 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
		throw new Error('Invalid Aliyun SMTP configuration');
	}

	const replyTo = resolveAliyunReplyTo({
		accountEmail: params.accountEmail,
		domainList: params.domainList,
		env
	});

	const to = (params.receiveEmail || []).map(emailAddress);
	if (!to.length || to.length > 50) throw new Error('Invalid recipient count');

	const attachments = params.attachments || [];
	if (attachments.length > 20) {
		throw new Error('Too many attachments');
	}

	const message = makeAliyunEmail({
		from: username,
		replyTo,
		to,
		name: params.name,
		subject: params.subject,
		text: params.text,
		html: params.html,
		sendType: params.sendType,
		messageId: params.messageId,
		attachments
	});

	const connectImpl = connectFn || (await import('cloudflare:sockets')).connect;
	const socket = connectImpl({ hostname: host, port }, { secureTransport: 'on' });
	const smtp = new SmtpConnection(socket, { timeoutMs });
	try {
		await withTimeout(socket.opened, timeoutMs, 'SMTP connect');
		await smtp.reply([220]);
		await smtp.command('EHLO cloud-mail', [250]);
		await smtp.command('AUTH LOGIN', [334]);
		await smtp.command(b64Utf8(username), [334]);
		await smtp.command(b64Utf8(password), [235]);
		await smtp.command(`MAIL FROM:<${username}>`, [250]);
		for (const recipient of to) {
			await smtp.command(`RCPT TO:<${recipient}>`, [250, 251]);
		}
		await smtp.command('DATA', [354]);
		await smtp.data(message.raw);
		await smtp.quit();
		return { id: message.id };
	} finally {
		await smtp.close();
	}
}
