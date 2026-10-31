// Turns a Ko-fi transaction export (Payments and orders → CSV) into SQL for the supporters table.
//   bun scripts/import-csv.ts <export.csv> > kofi-import.local.sql
//   bunx wrangler d1 execute supporters --remote --file kofi-import.local.sql
// The export does not say whether a tip was private, so every row is imported by name unless its
// TransactionId is listed in --private=<id,id>. Amounts and messages are never read.

const [path, ...flags] = process.argv.slice(2);
if (!path) throw new Error('usage: bun scripts/import-csv.ts <export.csv> [--private=<TransactionId,...>]');
const privateIds = new Set(
	flags
		.find((f) => f.startsWith('--private='))
		?.slice(10)
		.split(',') ?? [],
);

function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') row.push(field), (field = '');
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			row.push(field), rows.push(row), (row = []), (field = '');
		} else field += c;
	}
	if (field || row.length) row.push(field), rows.push(row);
	return rows.filter((r) => r.some(Boolean));
}

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const sql = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`);

// "08/21/2025 04:01" in UTC.
function isoDate(text: string): string {
	const [, m, d, y, hh, mm] = text.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/) ?? [];
	if (!y) throw new Error(`Unexpected date: ${text}`);
	return new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm)).toISOString();
}

const [header, ...rows] = parseCsv((await Bun.file(path).text()).replace(/^﻿/, ''));
const col = (name: string) => {
	const i = header.indexOf(name);
	if (i < 0) throw new Error(`Missing column: ${name}`);
	return i;
};
const [AT, FROM, TYPE, ID, EMAIL] = ['DateTime (UTC)', 'From', 'TransactionType', 'TransactionId', 'BuyerEmail'].map(col);

const out: string[] = [];
for (const r of rows) {
	const at = isoDate(r[AT]);
	const monthly = /monthly|subscription/i.test(r[TYPE]) ? 1 : 0;
	const name = r[FROM].replace(/\s+/g, ' ').trim().slice(0, 40) || null;
	if (privateIds.has(r[ID]) || !name) {
		out.push(`INSERT OR IGNORE INTO supporters (key, monthly, last_at) VALUES (${sql(`private:${r[ID]}`)}, ${monthly}, ${sql(at)});`);
		continue;
	}
	const email = r[EMAIL].trim().toLowerCase();
	const emailHash = email ? sha256(email) : null;
	const key = emailHash ?? `name:${sha256(name.toLowerCase())}`;
	const avatar = emailHash ? (await fetch(`https://gravatar.com/avatar/${emailHash}?s=8&d=404`, { method: 'HEAD' })).ok : false;
	out.push(
		`INSERT INTO supporters (key, name, email_hash, has_avatar, monthly, last_at) VALUES (${sql(key)}, ${sql(name)}, ${sql(emailHash)}, ${avatar ? 1 : 0}, ${monthly}, ${sql(at)})` +
			` ON CONFLICT (key) DO UPDATE SET monthly = max(monthly, excluded.monthly), last_at = max(last_at, excluded.last_at);`,
	);
}
console.log(out.join('\n'));
