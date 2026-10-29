import { describe, it, expect } from 'vitest';
import {
	attachmentBytes,
	emailAddress,
	makeAliyunEmail,
	resolveAliyunReplyTo,
	splitRecipientsByDomain,
	mimeHeader,
	b64Utf8
} from '../../src/service/aliyun-smtp-message.js';

const domainList = ['@corp.example.com', '@mail.example.com'];

describe('aliyun-smtp-message', () => {
	describe('emailAddress', () => {
		it('accepts valid addresses', () => {
			expect(emailAddress(' admin@corp.example.com ')).toBe('admin@corp.example.com');
		});

		it('rejects invalid addresses', () => {
			expect(() => emailAddress('not-an-email')).toThrow('Invalid email address');
			expect(() => emailAddress('a@b\nc.com')).toThrow('Invalid email address');
		});
	});

	describe('resolveAliyunReplyTo', () => {
		const env = { ALIYUN_REPLY_TO: 'admin@corp.example.com' };

		it('uses account email when domain allowed and matches verified reply-to', () => {
			expect(resolveAliyunReplyTo({
				accountEmail: 'admin@corp.example.com',
				domainList,
				env
			})).toBe('admin@corp.example.com');
		});

		it('fails when domain is not allowed', () => {
			expect(() => resolveAliyunReplyTo({
				accountEmail: 'admin@other.com',
				domainList,
				env: { ALIYUN_REPLY_TO: 'admin@other.com' }
			})).toThrow('Reply-To domain is not an allowed mailbox domain');
		});

		it('fails when account does not match verified Aliyun reply address', () => {
			expect(() => resolveAliyunReplyTo({
				accountEmail: 'other@corp.example.com',
				domainList,
				env
			})).toThrow('Reply-To must match the verified Aliyun reply address');
		});

		it('fails on invalid account email', () => {
			expect(() => resolveAliyunReplyTo({
				accountEmail: '',
				domainList,
				env
			})).toThrow('Invalid email address');
		});
	});

	describe('splitRecipientsByDomain', () => {
		it('splits internal and external recipients', () => {
			const result = splitRecipientsByDomain(
				['a@corp.example.com', 'b@gmail.com', 'c@mail.example.com'],
				domainList
			);
			expect(result.internal).toEqual(['a@corp.example.com', 'c@mail.example.com']);
			expect(result.external).toEqual(['b@gmail.com']);
		});

		it('treats all as external when domainList empty', () => {
			const result = splitRecipientsByDomain(['a@corp.example.com'], []);
			expect(result.internal).toEqual([]);
			expect(result.external).toEqual(['a@corp.example.com']);
		});
	});

	describe('mimeHeader / Chinese subject', () => {
		it('encodes non-ascii subject with UTF-8 B encoding', () => {
			const encoded = mimeHeader('测试主题');
			expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
			expect(encoded).not.toContain('测试');
		});

		it('keeps ascii subject plain', () => {
			expect(mimeHeader('Hello')).toBe('Hello');
		});
	});

	describe('makeAliyunEmail', () => {
		const base = {
			from: 'noreply@dm.example.com',
			replyTo: 'admin@corp.example.com',
			to: ['user@gmail.com'],
			name: 'Admin User',
			subject: 'Hello',
			text: 'plain body',
			html: null,
			sendType: '',
			messageId: null,
			attachments: []
		};

		it('builds plain text message with From and Reply-To', () => {
			const { id, raw } = makeAliyunEmail(base);
			expect(id).toMatch(/^<.+@dm\.example\.com>$/);
			expect(raw).toContain('From: "Admin User" <noreply@dm.example.com>');
			expect(raw).toContain('Reply-To: <admin@corp.example.com>');
			expect(raw).toContain('Subject: Hello');
			expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
			expect(raw).toContain(b64Utf8('plain body').slice(0, 8));
		});

		it('builds HTML multipart/alternative with Chinese subject', () => {
			const { raw } = makeAliyunEmail({
				...base,
				subject: '中文标题',
				html: '<p>你好</p>',
				text: '你好'
			});
			expect(raw).toContain('multipart/alternative');
			expect(raw).toContain('text/html; charset=UTF-8');
			expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
		});

		it('includes In-Reply-To for reply sendType', () => {
			const { raw } = makeAliyunEmail({
				...base,
				sendType: 'reply',
				messageId: '<orig@mail.example.com>'
			});
			expect(raw).toContain('In-Reply-To: <orig@mail.example.com>');
			expect(raw).toContain('References: <orig@mail.example.com>');
		});

		it('normalizes messageId without angle brackets', () => {
			const { raw } = makeAliyunEmail({
				...base,
				sendType: 'reply',
				messageId: 'orig@mail.example.com'
			});
			expect(raw).toContain('In-Reply-To: <orig@mail.example.com>');
		});

		it('embeds CID images in multipart/related', () => {
			const pngBase64 = btoa('fake-png');
			const { raw } = makeAliyunEmail({
				...base,
				html: '<p><img src="cid:img001"></p>',
				attachments: [{
					filename: 'embed.png',
					contentType: 'image/png',
					contentId: 'img001',
					content: pngBase64
				}]
			});
			expect(raw).toContain('multipart/related');
			expect(raw).toContain('Content-ID: <img001>');
			expect(raw).toContain('Content-Disposition: inline;');
		});

		it('attaches regular files in multipart/mixed', () => {
			const { raw } = makeAliyunEmail({
				...base,
				html: '<p>hi</p>',
				attachments: [{
					filename: '报告.pdf',
					contentType: 'application/pdf',
					content: btoa('pdf-bytes')
				}]
			});
			expect(raw).toContain('multipart/mixed');
			expect(raw).toContain('Content-Disposition: attachment;');
			expect(raw).toMatch(/filename\*=UTF-8''.*%E6%8A%A5%E5%91%8A\.pdf|filename="报告\.pdf"/);
		});

		it('supports multiple recipients in To header', () => {
			const { raw } = makeAliyunEmail({
				...base,
				to: ['a@gmail.com', 'b@outlook.com']
			});
			expect(raw).toContain('To: <a@gmail.com>, <b@outlook.com>');
		});
	});

	describe('attachmentBytes', () => {
		it('decodes base64 string', () => {
			const bytes = attachmentBytes({ content: btoa('abc') });
			expect(String.fromCharCode(...bytes)).toBe('abc');
		});

		it('accepts ArrayBuffer', () => {
			const buf = new TextEncoder().encode('xyz').buffer;
			const bytes = attachmentBytes({ content: buf });
			expect(String.fromCharCode(...bytes)).toBe('xyz');
		});

		it('rejects missing content', () => {
			expect(() => attachmentBytes({})).toThrow('Invalid attachment content');
		});
	});
});
