#!/usr/bin/env tsx

import { spawn, spawnSync } from 'node:child_process';

const port = parsePort(process.env.PORT ?? '3000');
const originHost = process.env.CLOUDFLARE_TUNNEL_ORIGIN_HOST ?? 'localhost';
const originUrl = `http://${originHost}:${String(port)}`;

assertCloudflaredInstalled();

console.log(`Starting free TryCloudflare tunnel for ${originUrl}`);
console.log(`Equivalent command: cloudflared tunnel --url ${originUrl}`);
console.log('cloudflared will print the random public trycloudflare.com URL in the terminal.');

const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', originUrl], {
  stdio: ['inherit', 'pipe', 'pipe'],
});

let announcedWebhookUrls = false;

tunnelProcess.stdout.on('data', (chunk: Buffer | string) => {
  const text = chunk.toString();
  process.stdout.write(text);
  announceWebhookUrls(text);
});

tunnelProcess.stderr.on('data', (chunk: Buffer | string) => {
  const text = chunk.toString();
  process.stderr.write(text);
  announceWebhookUrls(text);
});

tunnelProcess.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

function parsePort(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }

  return parsed;
}

function assertCloudflaredInstalled() {
  const result = spawnSync('cloudflared', ['--version'], {
    stdio: 'ignore',
  });

  if (result.status === 0) {
    return;
  }

  const installHint =
    process.platform === 'darwin'
      ? 'Install it with `brew install cloudflared`.'
      : 'Install it from https://developers.cloudflare.com/tunnel/downloads/.';

  throw new Error(`cloudflared is not installed. ${installHint}`);
}

function announceWebhookUrls(output: string) {
  if (announcedWebhookUrls) {
    return;
  }

  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) {
    return;
  }

  announcedWebhookUrls = true;
  const baseUrl = match[0];
  console.log(`Paste this into AgentMail: ${baseUrl}/webhooks/agentmail`);
  console.log(`Paste this into Stripe:    ${baseUrl}/webhooks/stripe`);
}
