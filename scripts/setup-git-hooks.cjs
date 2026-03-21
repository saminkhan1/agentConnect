#!/usr/bin/env node

const { execSync } = require("node:child_process");

function run(command, options = {}) {
	return execSync(command, { stdio: "pipe", ...options });
}

try {
	run("git rev-parse --is-inside-work-tree");
} catch {
	process.exit(0);
}

try {
	const currentHooksPath = run("git config --get core.hooksPath", {
		encoding: "utf8",
	}).trim();
	if (currentHooksPath === ".githooks") {
		process.exit(0);
	}
} catch {
	// No hooks path configured yet; set ours below.
}

run("git config core.hooksPath .githooks", { stdio: "inherit" });
console.log("Configured Git hooks path to .githooks");
