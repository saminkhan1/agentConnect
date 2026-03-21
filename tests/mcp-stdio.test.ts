import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runMcpStdio(env: Record<string, string | undefined>) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>(
		(resolve, reject) => {
			const child = spawn(pnpmCommand, ["exec", "tsx", "src/mcp-stdio.ts"], {
				cwd: repoRoot,
				env: {
					...process.env,
					NODE_ENV: "test",
					MCP_HTTP_ENABLED: "true",
					...env,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);

			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("mcp:stdio process timed out"));
			}, 15000);

			child.on("close", (code) => {
				clearTimeout(timeout);
				resolve({ code, stdout, stderr });
			});
		},
	);
}

void test("pnpm exec tsx src/mcp-stdio.ts exits non-zero on invalid AGENTINFRA_API_KEY", {
	concurrency: false,
}, async () => {
	const result = await runMcpStdio({
		AGENTINFRA_API_KEY: "sk_invalid",
	});

	assert.notStrictEqual(result.code, 0);
	assert.ok(
		`${result.stdout}\n${result.stderr}`.toLowerCase().includes("invalid"),
		"expected startup failure to be reported",
	);
});
