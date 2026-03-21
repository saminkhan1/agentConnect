# TryCloudflare for Local Webhooks

Use this when you need a public HTTPS URL for local webhook testing in development via [TryCloudflare](https://try.cloudflare.com/).

## Quick Start

1. Install `cloudflared`.

   On macOS:

   ```bash
   brew install cloudflared
   ```

2. Start your local app as usual.

   ```bash
   source .env && pnpm run dev
   ```

3. Run the free tunnel helper:

   ```bash
   pnpm run dev:webhooks
   ```

   This is just a thin wrapper around:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

   If you use a different local port, set `PORT` first.

4. Use the printed public hostname in provider dashboards:

   ```text
   https://<random>.trycloudflare.com/webhooks/agentmail
   https://<random>.trycloudflare.com/webhooks/stripe
   ```

## Notes

- This is the free TryCloudflare path. Cloudflare generates a random `trycloudflare.com` hostname and prints it in the terminal.
- The app listens on `PORT` with a default of `3000`, so the local origin is usually `http://localhost:3000`.
- If your server is reachable on a different local hostname, set `CLOUDFLARE_TUNNEL_ORIGIN_HOST` before running `pnpm run dev:webhooks`.

## References

- https://try.cloudflare.com/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- https://developers.cloudflare.com/tunnel/downloads/
