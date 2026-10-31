/** Ko-fi supporters for every Sponsor dialog.
 *
 *   POST /kofi            Ko-fi webhook (form field `data`, JSON); records the supporter.
 *   GET  /v1/supporters   latest supporters, one entry per person, newest first. No amounts;
 *                         `avatar` is a path on this origin.
 *   GET  /v1/avatar/:id   the supporter's Gravatar, proxied so the email hash stays private.
 *   GET  /roll.js         the <supporters-roll> element (static asset). */

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

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
