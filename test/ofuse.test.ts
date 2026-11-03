import { describe, expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { dmarcPassed, ofuseSupporter } from '../src/index';

// The body of OFUSE's notification for a letter with a tip, as received on 2026-11-03.
const BODY = [
	'',
	'げんご次郎さんから支援付きレターが届きました。',
	'レターボックスから確認してみましょう！',
	'',
	'げんご次郎さんがログインをしてレターを送っている場合、任意でお返事を返せます。',
	'',
	'レターボックスへ',
	'https://ofuse.me/login?to=/my/box',
].join('\n');

const mime = (encoding: 'base64' | 'quoted-printable', auth: string[]) => {
	const bytes = new TextEncoder().encode(BODY);
	const body =
		encoding === 'base64'
			? btoa(String.fromCharCode(...bytes))
			: [...bytes].map((b) => (b < 128 && b !== 61 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
	return [
		...auth.map((a) => `Authentication-Results: ${a}`),
		'From: OFUSE <no_reply@ofuse.me>',
		'To: someone@example.com',
		'Subject: =?UTF-8?B?44CQT0ZVU0XjgJHmlrDjgZfjgYTjg5XjgqHjg7Pjg6zjgr/jg7zjgYzlsYrjgYTjgabjgYTjgb7jgZnvvIE=?=',
		'Date: Tue, 3 Nov 2026 14:59:51 +0000',
		'Message-ID: <0106-test@ap-northeast-1.amazonses.com>',
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=UTF-8',
		`Content-Transfer-Encoding: ${encoding}`,
		'',
		body,
	].join('\r\n');
};

describe('OFUSE notification', () => {
	for (const encoding of ['base64', 'quoted-printable'] as const) {
		test(`reads the sender from a ${encoding} body`, async () => {
			const mail = await PostalMime.parse(mime(encoding, ['mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass']));
			expect(mail.from?.address).toBe('no_reply@ofuse.me');
			expect(ofuseSupporter(mail.text ?? '')).toBe('げんご次郎');
			expect(dmarcPassed(mail.headers)).toBe(true);
			expect(new Date(mail.date ?? '').toISOString()).toBe('2026-11-03T14:59:51.000Z');
		});
	}

	test('ignores mail that is not a letter with a tip', () => {
		expect(ofuseSupporter('げんご次郎さんからファンレターが届きました。')).toBeNull();
		expect(ofuseSupporter('収益化登録が完了しました！')).toBeNull();
	});

	test('trusts only the Authentication-Results header that Email Routing prepends', async () => {
		const failed = await PostalMime.parse(mime('base64', ['mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail', 'mx.cloudflare.net; dmarc=pass']));
		expect(dmarcPassed(failed.headers)).toBe(false);
		const forged = await PostalMime.parse(mime('base64', ['evil.example; dmarc=pass']));
		expect(dmarcPassed(forged.headers)).toBe(false);
		const missing = await PostalMime.parse(mime('base64', []));
		expect(dmarcPassed(missing.headers)).toBe(false);
	});
});
