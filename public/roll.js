// <supporters-roll> — a looping strip of the latest Ko-fi supporters, newest first.
//
//   <script type="module" src="https://supporters.mkpo.li/roll.js"></script>
//   <supporters-roll label="Recent supporters" anonymous="Someone"></supporters-roll>
//
// Attributes: `label` (heading), `anonymous` (name shown for private tips), `src` (API origin,
// defaults to this script's origin). Relative times follow the nearest `lang`. The element stays
// hidden until the list loads and has entries. Colours inherit from the dialog: --sp-text,
// --sp-muted, --sp-soft and --sp-line when set, otherwise currentColor.

const ORIGIN = new URL(import.meta.url).origin;
const STEPS = [
	['year', 31536000],
	['month', 2592000],
	['week', 604800],
	['day', 86400],
	['hour', 3600],
	['minute', 60],
];

function ago(iso, lang) {
	const seconds = Math.min(0, (new Date(iso).getTime() - Date.now()) / 1000);
	const rtf = new Intl.RelativeTimeFormat(lang || undefined, { numeric: 'auto' });
	for (const [unit, size] of STEPS) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
	return rtf.format(0, 'minute');
}

function hue(text) {
	let h = 0;
	for (const c of text) h = (h * 31 + c.codePointAt(0)) % 360;
	return h;
}

const CSS = `
:host{display:block;color:var(--sp-text,currentColor)}
:host([hidden]){display:none}
h3{margin:0 0 8px;font:inherit;font-size:12px;font-weight:700;color:var(--sp-muted,inherit);opacity:.9}
.viewport{overflow:hidden;mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent)}
.track{display:flex;gap:8px;width:max-content;animation:roll var(--duration) linear infinite}
.viewport:hover .track,.viewport:focus-within .track{animation-play-state:paused}
.copy{display:contents}
@keyframes roll{to{transform:translateX(calc(-50% - 4px))}}
@media (prefers-reduced-motion:reduce){
  .viewport{mask-image:none}
  .track{flex-wrap:wrap;width:auto;animation:none}
  .copy{display:none}
}
.chip{display:flex;align-items:center;gap:7px;padding:4px 10px 4px 4px;border:1px solid var(--sp-line,color-mix(in oklab,currentColor 18%,transparent));border-radius:999px;background:var(--sp-soft,transparent);white-space:nowrap;font-size:12.5px;line-height:1.2}
.icon{position:relative;flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;overflow:hidden;color:#fff;font-weight:700;font-size:11px}
.icon img{width:100%;height:100%;object-fit:cover}
.icon svg{width:14px;height:14px;fill:currentColor}
.name{font-weight:600}
.when{color:var(--sp-muted,inherit);opacity:.85}
`;

const PERSON =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0Z"/></svg>';

class SupportersRoll extends HTMLElement {
	connectedCallback() {
		if (this.shadowRoot) return;
		this.hidden = true;
		this.attachShadow({ mode: 'open' });
		this.load().catch(() => {});
	}

	async load() {
		const src = this.getAttribute('src') || ORIGIN;
		const response = await fetch(`${src}/v1/supporters`);
		if (!response.ok) return;
		const { supporters } = await response.json();
		if (!supporters?.length) return;
		const lang = this.closest('[lang]')?.getAttribute('lang') || document.documentElement.lang;
		const anonymous = this.getAttribute('anonymous') || 'Someone';

		const chip = (s) => {
			const el = document.createElement('span');
			el.className = 'chip';
			const icon = document.createElement('span');
			icon.className = 'icon';
			const name = s.name || anonymous;
			if (s.avatar) {
				const img = document.createElement('img');
				img.src = new URL(s.avatar, src).href;
				img.alt = '';
				img.loading = 'lazy';
				icon.append(img);
			} else if (s.name) {
				icon.textContent = [...s.name][0].toUpperCase();
				icon.style.background = `oklch(62% .13 ${hue(s.name)})`;
			} else {
				icon.innerHTML = PERSON;
				icon.style.background = 'var(--sp-muted, #8a8a8a)';
			}
			const label = document.createElement('span');
			label.className = 'name';
			label.textContent = name;
			const when = document.createElement('span');
			when.className = 'when';
			when.textContent = ago(s.at, lang);
			el.append(icon, label, when);
			return el;
		};

		const style = document.createElement('style');
		style.textContent = CSS;
		const heading = document.createElement('h3');
		heading.textContent = this.getAttribute('label') || 'Recent supporters';
		const list = document.createElement('div');
		list.className = 'track';
		list.setAttribute('role', 'list');
		list.style.setProperty('--duration', `${Math.max(20, supporters.length * 4)}s`);
		for (const s of supporters) {
			const item = chip(s);
			item.setAttribute('role', 'listitem');
			list.append(item);
		}
		// A second copy makes the loop seamless; assistive tech reads the list once.
		const copy = document.createElement('span');
		copy.setAttribute('aria-hidden', 'true');
		copy.className = 'copy';
		for (const s of supporters) copy.append(chip(s));
		list.append(copy);
		const viewport = document.createElement('div');
		viewport.className = 'viewport';
		viewport.tabIndex = 0;
		viewport.append(list);
		this.shadowRoot.append(style, heading, viewport);
		this.hidden = false;
	}
}

if (!customElements.get('supporters-roll')) customElements.define('supporters-roll', SupportersRoll);
