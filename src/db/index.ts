import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";

import { resolveDatabaseUrl } from "../config";
import * as schema from "./schema";

function createPool() {
	return new Pool({
		connectionString: resolveDatabaseUrl(process.env),
		// Allows tests/short-lived scripts to exit cleanly without explicit pool shutdown.
		allowExitOnIdle: true,
	});
}

function createDbClient(client: Pool) {
	return drizzle({ client, schema });
}

export let pool = createPool();
export let db = createDbClient(pool);

let isPoolClosed = false;

export function ensureDbIsReady() {
	if (!isPoolClosed) {
		return;
	}

	pool = createPool();
	db = createDbClient(pool);
	isPoolClosed = false;
}

export async function closeDbPool() {
	if (isPoolClosed) {
		return;
	}

	await pool.end();
	isPoolClosed = true;
}

async function acquireAdvisoryLock(client: PoolClient, lockKey: string) {
	await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
		lockKey,
	]);
}

async function releaseAdvisoryLock(client: PoolClient, lockKey: string) {
	await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
		lockKey,
	]);
}

export async function withAdvisoryLock<T>(
	lockKey: string,
	callback: () => Promise<T>,
): Promise<T> {
	ensureDbIsReady();

	const client = await pool.connect();
	try {
		await acquireAdvisoryLock(client, lockKey);
		try {
			return await callback();
		} finally {
			await releaseAdvisoryLock(client, lockKey).catch(() => {});
		}
	} finally {
		client.release();
	}
}
