// Pure Aliyun DirectMail MIME / Reply-To helpers (no TCP). Unit-testable in Node.

const encoder = new TextEncoder();

export function emailAddress(value) {
	const address = String(value || '').trim();
	if (!/^[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+$/.test(address)) {
		throw new Error('Invalid email address');
	}
	return address;
}

export function headerValue(value) {
	return String(value ?? '').replace(/[\r\n\0]/g, ' ').trim();
}

export function b64Bytes(bytes) {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let output = '';
	for (let i = 0; i < view.length; i += 0x4000) {
		output += String.fromCharCode(...view.subarray(i, i + 0x4000));
	}
	return btoa(output);
}

export function b64Utf8(value) {
	return b64Bytes(encoder.encode(String(value ?? '')));
}

export function mimeHeader(value) {
	const input = headerValue(value);
	if (/^[\x20-\x7e]*$/.test(input)) return input;
	const chunks = [];
	let chunk = '';
	for (const char of input) {
		if (encoder.encode(chunk + char).length > 42 && chunk) {
			chunks.push(`=?UTF-8?B?${b64Utf8(chunk)}?=`);
			chunk = '';
		}
		chunk += char;
	}
	if (chunk) chunks.push(`=?UTF-8?B?${b64Utf8(chunk)}?=`);
	return chunks.join('\r\n ');
}

function formatMailbox(address, name) {
	if (!name || name === address) {
		return `<${address}>`;
	}
	const encoded = mimeHeader(name);
	if (encoded.startsWith('=?')) {
		return `${encoded} <${address}>`;
	}
	if (/[()<>[\]:;@\\,"]/.test(name) || /\s/.test(name)) {
		return `"${String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${address}>`;
	}
	return `${encoded} <${address}>`;
}

function filenameParam(filename = 'file') {
	const name = headerValue(filename) || 'file';
	if (/^[\x20-\x7E]*$/.test(name) && !/["\\]/.test(name)) {
		return `filename="${name}"`;
	}
	return `filename*=UTF-8''${encodeURIComponent(name)}`;
}

function wrapBase64(b64) {
	return String(b64 || '').match(/.{1,76}/g)?.join('\r\n') || '';
}

/** Decode attachment.content / .buff to bytes (base64 string or ArrayBuffer). */
export function attachmentBytes(attachment) {
	let content = attachment?.content ?? attachment?.buff;
	if (!content) {
		throw new Error('Invalid attachment content');
	}
	if (content instanceof ArrayBuffer) {
		return new Uint8Array(content);
	}
	if (content instanceof Uint8Array) {
		return content;
	}
	if (typeof content === 'string') {
		let raw = content;
		if (raw.startsWith('data:')) {
			raw = raw.split(',')[1] || '';
		}
		raw = raw.replace(/\s+/g, '');
		try {
			const binary = atob(raw);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			return bytes;
		} catch {
			throw new Error('Invalid attachment content');
		}
	}
	throw new Error('Invalid attachment content');
}

function mimePart(contentType, bodyBytes, extraHeaders = []) {
	return [
		`Content-Type: ${contentType}`,
		'Content-Transfer-Encoding: base64',
		...extraHeaders,
		'',
		wrapBase64(b64Bytes(bodyBytes))
	].join('\r\n');
}

function normalizeContentId(contentId) {
	const bare = headerValue(contentId).replace(/^<|>$/g, '');
	if (!bare || /[<>\r\n]/.test(bare)) {
		throw new Error('Invalid attachment contentId');
	}
	return bare;
}

/**
 * Reply-To must be the current Cloud Mail account, on an allowed domain,
 * and match the Aliyun-verified reply address (ALIYUN_REPLY_TO).
 */
export function resolveAliyunReplyTo({ accountEmail, domainList, env }) {
	const replyTo = emailAddress(accountEmail);
	const verified = emailAddress(env?.ALIYUN_REPLY_TO);

	const domains = Array.isArray(domainList) ? domainList : [];
	const replyDomain = '@' + replyTo.split('@')[1].toLowerCase();
	const allowed = domains.some(item => String(item).toLowerCase() === replyDomain);
	if (!allowed) {
		throw new Error('Reply-To domain is not an allowed mailbox domain');
	}

	// DirectMail: SMTP Reply-To should be the verified reply address.
	if (replyTo.toLowerCase() !== verified.toLowerCase()) {
		throw new Error('Reply-To must match the verified Aliyun reply address');
	}

	return replyTo;
}

export function makeAliyunEmail({
	from,
	replyTo,
	to,
	name,
	subject,
	text,
	html,
	sendType,
	messageId,
	attachments = []
}) {
	const id = `<${crypto.randomUUID()}@${from.split('@')[1]}>`;
	const headers = [
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: ${id}`,
		`From: ${formatMailbox(from, name)}`,
		`To: ${to.map(addr => `<${addr}>`).join(', ')}`,
		`Reply-To: <${replyTo}>`,
		`Subject: ${mimeHeader(subject)}`,
		'MIME-Version: 1.0'
	];

	if (sendType === 'reply' && messageId) {
		let clean = headerValue(messageId);
		if (clean && !clean.startsWith('<')) {
			clean = `<${clean}>`;
		}
		if (/^<[^<>\r\n]+>$/.test(clean)) {
			headers.push(`In-Reply-To: ${clean}`);
			headers.push(`References: ${clean}`);
		}
	}

	const plainText = text || (html ? String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') : '');
	const alt = `alt_${crypto.randomUUID().replace(/-/g, '')}`;
	const alternative = [
		`--${alt}`,
		mimePart('text/plain; charset=UTF-8', encoder.encode(plainText)),
		...(html ? [`--${alt}`, mimePart('text/html; charset=UTF-8', encoder.encode(String(html)))] : []),
		`--${alt}--`
	].join('\r\n');

	const inlineParts = [];
	const fileParts = [];
	for (const attachment of attachments) {
		const bytes = attachmentBytes(attachment);
		const type = attachment.mimeType || attachment.contentType || attachment.type || 'application/octet-stream';
		const filename = attachment.filename || 'file';
		const hasCid = Boolean(attachment.contentId);
		const disposition = hasCid ? 'inline' : (attachment.disposition || 'attachment');
		const extra = [`Content-Disposition: ${disposition}; ${filenameParam(filename)}`];
		if (hasCid) {
			extra.push(`Content-ID: <${normalizeContentId(attachment.contentId)}>`);
			inlineParts.push(mimePart(type, bytes, extra));
		} else {
			fileParts.push(mimePart(type, bytes, extra));
		}
	}

	let body;
	if (inlineParts.length === 0 && fileParts.length === 0) {
		if (html) {
			headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
			body = alternative;
		} else {
			headers.push('Content-Type: text/plain; charset=UTF-8');
			headers.push('Content-Transfer-Encoding: base64');
			body = wrapBase64(b64Utf8(plainText));
		}
	} else if (fileParts.length === 0) {
		const related = `rel_${crypto.randomUUID().replace(/-/g, '')}`;
		headers.push(`Content-Type: multipart/related; boundary="${related}"`);
		body = [
			`--${related}`,
			`Content-Type: multipart/alternative; boundary="${alt}"`,
			'',
			alternative,
			...inlineParts.flatMap(part => [`--${related}`, part]),
			`--${related}--`
		].join('\r\n');
	} else {
		const mixed = `mix_${crypto.randomUUID().replace(/-/g, '')}`;
		headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
		const parts = [];
		if (inlineParts.length > 0) {
			const related = `rel_${crypto.randomUUID().replace(/-/g, '')}`;
			parts.push(`--${mixed}`);
			parts.push(`Content-Type: multipart/related; boundary="${related}"`);
			parts.push('');
			parts.push(`--${related}`);
			parts.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
			parts.push('');
			parts.push(alternative);
			for (const part of inlineParts) {
				parts.push(`--${related}`, part);
			}
			parts.push(`--${related}--`);
		} else {
			parts.push(`--${mixed}`);
			parts.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
			parts.push('');
			parts.push(alternative);
		}
		for (const part of fileParts) {
			parts.push(`--${mixed}`, part);
		}
		parts.push(`--${mixed}--`);
		body = parts.join('\r\n');
	}

	return { id, raw: `${headers.join('\r\n')}\r\n\r\n${body}\r\n` };
}

export function splitRecipientsByDomain(receiveEmail = [], domainList = []) {
	const domains = (domainList || []).map(item => String(item).toLowerCase());
	const internal = [];
	const external = [];
	for (const address of receiveEmail) {
		const domain = '@' + String(address).split('@')[1]?.toLowerCase();
		if (domains.includes(domain)) {
			internal.push(address);
		} else {
			external.push(address);
		}
	}
	return { internal, external };
}
