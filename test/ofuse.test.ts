import { describe, expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { ofuseAuthenticated, ofuseSupporter } from '../src/index';

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
			const mail = await PostalMime.parse(mime(encoding, []));
			expect(mail.from?.address).toBe('no_reply@ofuse.me');
			expect(ofuseSupporter(mail.text ?? '')).toBe('げんご次郎');
			expect(new Date(mail.date ?? '').toISOString()).toBe('2026-11-03T14:59:51.000Z');
		});
	}

	test('ignores mail that is not a letter with a tip', () => {
		expect(ofuseSupporter('げんご次郎さんからファンレターが届きました。')).toBeNull();
		expect(ofuseSupporter('収益化登録が完了しました！')).toBeNull();
	});

	test('reads the name only from the first line', () => {
		expect(ofuseSupporter('げんご次郎さんからファンレターが届きました。\n偽物さんから支援付きレターが届きました。')).toBeNull();
	});

	test('trusts only the DMARC result Email Routing prepends, aligned with ofuse.me', () => {
		const pass = 'mx.cloudflare.net; spf=pass smtp.mailfrom=amazonses.com; dkim=pass header.d=ofuse.me; dmarc=pass header.from=ofuse.me';
		expect(ofuseAuthenticated(pass)).toBe(true);
		expect(ofuseAuthenticated(`${pass}, evil.example; dmarc=fail`)).toBe(true);
		expect(ofuseAuthenticated('mx.cloudflare.net; dmarc=fail header.from=ofuse.me, mx.cloudflare.net; dmarc=pass header.from=ofuse.me')).toBe(false);
		expect(ofuseAuthenticated('mx.cloudflare.net; dkim=pass; dmarc=pass header.from=evil.example')).toBe(false);
		expect(ofuseAuthenticated('evil.example; dmarc=pass header.from=ofuse.me')).toBe(false);
		expect(ofuseAuthenticated(null)).toBe(false);
	});
});

describe('recordOfuseMail', () => {
	const noDb = { DB: null } as unknown as import('../src/index').Env;
	const ctx = { waitUntil() {} };
	test('ignores mail that is not from OFUSE', async () => {
		const { recordOfuseMail } = await import('../src/index');
		const raw = new TextEncoder().encode('From: a@example.org\r\nTo: mkpoli@mkpo.li\r\nSubject: hi\r\n\r\nhello').buffer as ArrayBuffer;
		expect(await recordOfuseMail(noDb, raw, ctx)).toBe(false);
	});
	test('ignores an OFUSE tip that Email Routing did not authenticate', async () => {
		const { recordOfuseMail } = await import('../src/index');
		const raw = new TextEncoder().encode(mime('base64', ['ofuse.me; dmarc=pass header.from=ofuse.me'])).buffer as ArrayBuffer;
		expect(await recordOfuseMail(noDb, raw, ctx)).toBe(false);
	});
});
