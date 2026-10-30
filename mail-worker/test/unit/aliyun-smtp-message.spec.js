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
		});
	});

	describe('resolveAliyunReplyTo', () => {
		it('uses account email when domain allowed and matches smtp user', () => {
			expect(resolveAliyunReplyTo({
				accountEmail: '1@corp.example.com',
				domainList,
				smtpUser: '1@corp.example.com'
			})).toBe('1@corp.example.com');
		});

		it('fails when domain is not allowed', () => {
			expect(() => resolveAliyunReplyTo({
				accountEmail: 'admin@other.com',
				domainList,
				smtpUser: 'admin@other.com'
			})).toThrow('Reply-To domain is not an allowed mailbox domain');
		});

		it('fails when smtp user would impersonate another mailbox', () => {
			expect(() => resolveAliyunReplyTo({
				accountEmail: '1@corp.example.com',
				domainList,
				smtpUser: 'noreply@notify.corp.example.com'
			})).toThrow('Reply-To must match SMTP user and account email');
		});

		it('does not require global ALIYUN_REPLY_TO', () => {
			expect(resolveAliyunReplyTo({
				accountEmail: '2@corp.example.com',
				domainList,
				smtpUser: '2@corp.example.com'
			})).toBe('2@corp.example.com');
		});

		it('domain mode accepts Reply-To without AUTH equaling mailbox', () => {
			expect(resolveAliyunReplyTo({
				accountEmail: '1@corp.example.com',
				domainList,
				authMode: 'domain',
				sendDomain: 'corp.example.com',
			})).toBe('1@corp.example.com');
		});

		it('domain mode rejects sendDomain mismatch', () => {
			expect(() => resolveAliyunReplyTo({
				accountEmail: '1@corp.example.com',
				domainList,
				authMode: 'domain',
				sendDomain: 'other.com',
			})).toThrow(/does not match DomainAuth send domain/);
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
	});

	describe('mimeHeader / Chinese subject', () => {
		it('encodes non-ascii subject with UTF-8 B encoding', () => {
			const encoded = mimeHeader('测试主题');
			expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
		});
	});

	describe('makeAliyunEmail', () => {
		const base = {
			from: '1@corp.example.com',
			replyTo: '1@corp.example.com',
			to: ['user@gmail.com'],
			name: 'User One',
			subject: 'Hello',
			text: 'plain body',
			html: null,
			sendType: '',
			messageId: null,
			attachments: []
		};

		it('builds message with From and Reply-To equal to mailbox', () => {
			const { raw } = makeAliyunEmail(base);
			expect(raw).toContain('From: "User One" <1@corp.example.com>');
			expect(raw).toContain('Reply-To: <1@corp.example.com>');
			expect(raw).not.toContain('noreply@');
		});

		it('builds HTML with Chinese subject', () => {
			const { raw } = makeAliyunEmail({
				...base,
				subject: '中文标题',
				html: '<p>你好</p>',
				text: '你好'
			});
			expect(raw).toContain('multipart/alternative');
			expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
		});

		it('includes In-Reply-To for reply', () => {
			const { raw } = makeAliyunEmail({
				...base,
				sendType: 'reply',
				messageId: '<orig@mail.example.com>'
			});
			expect(raw).toContain('In-Reply-To: <orig@mail.example.com>');
		});

		it('embeds CID images and file attachments', () => {
			const { raw } = makeAliyunEmail({
				...base,
				html: '<p><img src="cid:img001"></p>',
				attachments: [{
					filename: 'embed.png',
					contentType: 'image/png',
					contentId: 'img001',
					content: btoa('fake-png')
				}, {
					filename: '报告.pdf',
					contentType: 'application/pdf',
					content: btoa('pdf-bytes')
				}]
			});
			expect(raw).toContain('multipart/mixed');
			expect(raw).toContain('Content-ID: <img001>');
			expect(raw).toContain('Content-Disposition: attachment;');
		});

		it('supports multiple recipients', () => {
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

		it('rejects missing content', () => {
			expect(() => attachmentBytes({})).toThrow('Invalid attachment content');
		});
	});
});
