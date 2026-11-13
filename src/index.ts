/** Ko-fi and OFUSE supporters for every Sponsor dialog.
 *
 *   POST /kofi            Ko-fi webhook (form field `data`, JSON); records the supporter.
 *   OfuseInbox.record     RPC from the mailbox Worker with each raw message it receives; records
 *                         the sender of OFUSE's notification for a letter with a tip.
 *   GET  /v1/supporters   latest supporters, one entry per person, newest first. No amounts;
 *                         `avatar` is a path on this origin.
 *   GET  /v1/avatar/:id   the supporter's Gravatar, proxied so the email hash stays private.
 *   GET  /roll.js         the <supporters-roll> element (static asset). */

import PostalMime from 'postal-mime';

export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	KOFI_TOKEN: string;
}

export type Supporter = { id: number; name: string | null; monthly: boolean; at: string; avatar: string | null };

export type KofiPayload = {
	verification_token?: string;
	message_id?: string;
	timestamp?: string;
	type?: string;
	is_public?: boolean;
	from_name?: string;
	email?: string;
	is_subscription_payment?: boolean;
};

const LIMIT = 30;
const ORIGIN = 'https://supporters.mkpo.li';
const OFUSE_SENDER = 'no_reply@ofuse.me';
const CORS = { 'access-control-allow-origin': '*' };

export async function sha256(text: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function cleanName(name: string | undefined): string | null {
	const trimmed = (name ?? '').replace(/\s+/g, ' ').trim();
	return trimmed ? [...trimmed].slice(0, 40).join('') : null;
}

const gravatar = (hash: string, size = 96) => `https://gravatar.com/avatar/${hash}?s=${size}&d=404`;

/** Records one Ko-fi event. Returns false when the token does not match. */
export async function record(env: Env, data: KofiPayload, hasAvatar: (hash: string) => Promise<boolean>): Promise<boolean> {
	if (!env.KOFI_TOKEN || data.verification_token !== env.KOFI_TOKEN) return false;
	const messageId = String(data.message_id ?? '');
	if (!messageId) return true;
	const fresh = await env.DB.prepare('INSERT OR IGNORE INTO seen (message_id) VALUES (?)').bind(messageId).run();
	if (!fresh.meta.changes) return true;

	const at = new Date(data.timestamp ?? Date.now()).toISOString();
	const monthly = data.is_subscription_payment ? 1 : 0;
	const name = data.is_public === false ? null : cleanName(data.from_name);
	if (!name) {
		await env.DB.prepare('INSERT INTO supporters (key, monthly, last_at) VALUES (?, ?, ?)')
			.bind(`private:${messageId}`, monthly, at)
			.run();
		return true;
	}
	const email = (data.email ?? '').trim().toLowerCase();
	const emailHash = email ? await sha256(email) : null;
	const key = emailHash ?? `name:${await sha256(name.toLowerCase())}`;
	const avatar = emailHash ? await hasAvatar(emailHash) : false;
	await env.DB.prepare(
		`INSERT INTO supporters (key, name, email_hash, has_avatar, monthly, last_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
		 ON CONFLICT (key) DO UPDATE SET name = ?2, has_avatar = ?4, monthly = max(monthly, ?5),
		   last_at = max(last_at, ?6)`,
	)
		.bind(key, name, emailHash, avatar ? 1 : 0, monthly, at)
		.run();
	return true;
}

/** The sender named on the first line of OFUSE's notification for a letter that came with a tip
 *  ("げんご次郎さんから支援付きレターが届きました。"), or null for any other mail. Later lines can
 *  quote text a reader wrote, so only the first one counts. */
export function ofuseSupporter(text: string): string | null {
	const first = text.split('\n').find((line) => line.trim()) ?? '';
	const match = first.match(/^\s*(.+?)さんから支援付きレターが届きました/);
	return match ? cleanName(match[1]) : null;
}

/** Whether Email Routing found the mail DMARC-aligned with ofuse.me. Email Routing prepends its own
 *  Authentication-Results header, and `Headers.get` joins repeated headers with ", ", so only the
 *  text before the next "<authserv-id>;" is Cloudflare's; later ones came from the sender. */
export function ofuseAuthenticated(authenticationResults: string | null): boolean {
	const first = (authenticationResults ?? '').split(/,\s*(?=[\w.-]+\s*;)/)[0];
	return (
		/^\s*mx\.cloudflare\.net\s*;/i.test(first) &&
		/\bdmarc=pass\b/i.test(first) &&
		/\bheader\.from=ofuse\.me\b/i.test(first)
	);
}

/** Records one OFUSE tip by the sender's name, in one transaction with its Message-ID so a retried
 *  delivery neither loses nor repeats it. Returns false when the message was seen before. */
export async function recordOfuse(env: Env, messageId: string, name: string, at: string): Promise<boolean> {
	const [seen] = await env.DB.batch([
		env.DB.prepare('INSERT OR IGNORE INTO seen (message_id) VALUES (?)').bind(`ofuse:${messageId}`),
		env.DB.prepare(
			`INSERT INTO supporters (key, name, last_at)
			 SELECT ?1, ?2, ?3 WHERE changes() > 0
			 ON CONFLICT (key) DO UPDATE SET name = ?2, last_at = max(last_at, ?3)`,
		).bind(`ofuse:${await sha256(name.toLowerCase())}`, name, at),
	]);
	return seen.meta.changes > 0;
}

export async function list(env: Env): Promise<Supporter[]> {
	const { results } = await env.DB.prepare(
		'SELECT id, name, has_avatar, monthly, last_at FROM supporters WHERE hidden = 0 ORDER BY last_at DESC LIMIT ?',
	)
		.bind(LIMIT)
		.all<{ id: number; name: string | null; has_avatar: number; monthly: number; last_at: string }>();
	return results.map((r) => ({
		id: r.id,
		name: r.name,
		monthly: !!r.monthly,
		at: r.last_at,
		avatar: r.name && r.has_avatar ? `/v1/avatar/${r.id}` : null,
	}));
}

async function cached(request: Request, ctx: ExecutionContext, maxAge: number, make: () => Promise<Response>) {
	const cache = caches.default;
	const hit = await cache.match(request);
	if (hit) return hit;
	const response = await make();
	if (response.ok) {
		response.headers.set('cache-control', `public, max-age=${maxAge}`);
		ctx.waitUntil(cache.put(request, response.clone()));
	}
	return response;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/kofi' && request.method === 'POST') {
			const form = await request.formData();
			let data: KofiPayload;
			try {
				data = JSON.parse(String(form.get('data') ?? ''));
			} catch {
				return new Response('Bad payload', { status: 400 });
			}
			const ok = await record(env, data, async (hash) => (await fetch(gravatar(hash, 8), { method: 'HEAD' })).ok);
			// A new tip shows on the next page load instead of after the list's cache expires.
			if (ok) ctx.waitUntil(caches.default.delete(`${url.origin}/v1/supporters`));
			return new Response(ok ? 'OK' : 'Forbidden', { status: ok ? 200 : 403 });
		}

		if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

		if (url.pathname === '/v1/supporters') {
			return cached(new Request(url.origin + url.pathname), ctx, 300, async () =>
				Response.json({ supporters: await list(env) }, { headers: CORS }),
			);
		}

		const avatar = url.pathname.match(/^\/v1\/avatar\/(\d{1,12})$/);
		if (avatar) {
			return cached(new Request(url.origin + url.pathname), ctx, 86400, async () => {
				const row = await env.DB.prepare('SELECT email_hash FROM supporters WHERE id = ? AND hidden = 0 AND has_avatar = 1')
					.bind(Number(avatar[1]))
					.first<{ email_hash: string }>();
				if (!row) return new Response('Not found', { status: 404, headers: CORS });
				const image = await fetch(gravatar(row.email_hash));
				if (!image.ok) return new Response('Not found', { status: 404, headers: CORS });
				return new Response(image.body, {
					headers: { ...CORS, 'content-type': image.headers.get('content-type') ?? 'image/jpeg' },
				});
			});
		}

		// Sites load roll.js as a cross-origin module script, which browsers refuse without CORS.
		const asset = await env.ASSETS.fetch(request);
		const response = new Response(asset.body, asset);
		response.headers.set('access-control-allow-origin', '*');
		return response;
	},
} satisfies ExportedHandler<Env>;

/** Records the tip in OFUSE's notification for a letter, when `raw` is one. Only a message Email
 *  Routing found DMARC-aligned with ofuse.me counts. Returns whether a new tip was recorded. */
export async function recordOfuseMail(env: Env, raw: ArrayBuffer, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<boolean> {
	const mail = await PostalMime.parse(raw);
	const auth = mail.headers.filter((h) => h.key === 'authentication-results').map((h) => h.value);
	const senders = mail.headers.filter((h) => h.key === 'from').length;
	const single = senders === 1 && mail.from?.address?.toLowerCase() === OFUSE_SENDER && !mail.from.group;
	if (!single || !ofuseAuthenticated(auth.join(', '))) return false;
	const name = ofuseSupporter(mail.text ?? '');
	if (!name) return false;
	if (!mail.messageId) {
		console.error('OFUSE tip without a Message-ID; not recorded.', name);
		return false;
	}
	const sent = new Date(mail.date ?? '');
	// A clock ahead of ours would keep the supporter first on the roll for good.
	const at = new Date(Number.isNaN(sent.getTime()) ? Date.now() : Math.min(sent.getTime(), Date.now())).toISOString();
	const recorded = await recordOfuse(env, mail.messageId, name, at);
	if (recorded) ctx.waitUntil(caches.default.delete(`${ORIGIN}/v1/supporters`));
	return recorded;
}
