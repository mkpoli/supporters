import { WorkerEntrypoint } from 'cloudflare:workers';
import handler, { type Env, recordOfuseMail } from './index';

export default handler;

/** Bound by the mailbox Worker, which receives the mail OFUSE sends and passes each message here. */
export class OfuseInbox extends WorkerEntrypoint<Env> {
	async record(raw: ArrayBuffer): Promise<boolean> {
		return recordOfuseMail(this.env, raw, this.ctx);
	}
}
