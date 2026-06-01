# Cloudflare Worker — docs proxy

Worker that proxies `https://comfyui-mcp.artokun.io/docs*` to the Mintlify
deployment at `artokun.mintlify.dev`. Bare-root requests 302 to `/docs`;
anything else on the host returns 404 (this host is docs-only).

- Worker source: `docs-proxy.js`
- Wrangler config: `wrangler.jsonc`
- Production URL: <https://comfyui-mcp.artokun.io/docs>
- Mintlify origin: <https://artokun.mintlify.dev/docs>

## Prerequisites (must all be true for the public URL to work)

1. **DNS record** — `comfyui-mcp` AAAA/A or CNAME record exists on the
   `artokun.io` zone in Cloudflare, **with the proxy (orange cloud) enabled**.
   Without this record the Worker route never fires and clients get NXDOMAIN /
   `curl: (6) Could not resolve host`.
2. **Worker deployed** — `comfyui-mcp-docs-proxy` is deployed on the account
   matching `account_id` in `wrangler.jsonc`.
3. **Worker route attached** — `comfyui-mcp.artokun.io/*` on `artokun.io` zone
   (declared in `wrangler.jsonc`, applied at deploy time).
4. **Mintlify custom domain** — Mintlify project has
   `comfyui-mcp.artokun.io/docs` configured so generated asset/link URLs use
   the `/docs` prefix.

## Deploy

```bash
cd infra/cloudflare
npx wrangler deploy
```

Wrangler must be authenticated against the Cloudflare account that owns the
`artokun.io` zone (account id `208c358f58d75a3fc684695473f431dd`). Verify with
`wrangler whoami` — if it shows a different account, run
`wrangler logout && wrangler login` and pick the right account in the OAuth
flow.

## Recovery: `comfyui-mcp.artokun.io` returns NXDOMAIN

Symptoms:

```text
$ curl -I https://comfyui-mcp.artokun.io/docs
curl: (6) Could not resolve host: comfyui-mcp.artokun.io
$ dig comfyui-mcp.artokun.io @drake.ns.cloudflare.com +short   # empty
```

Cause: the DNS record for the `comfyui-mcp` subdomain has been deleted from
the `artokun.io` zone, or its proxy was disabled and the underlying target
is unreachable. The Worker can be deployed and the route attached, but
without the DNS record the hostname has no IP.

Fix (Cloudflare dashboard):

1. Dashboard → `artokun.io` zone → **DNS → Records**.
2. Add a record:
   - Type: `AAAA`
   - Name: `comfyui-mcp`
   - IPv6 address: `100::` (RFC 6666 discard prefix — value is irrelevant
     because the request never leaves Cloudflare; the Worker route intercepts
     it). An `A 192.0.2.1` placeholder works equally well.
   - **Proxy status: Proxied (orange cloud)** — this is mandatory.
   - TTL: Auto.
3. Save. Propagation on Cloudflare's own resolvers is near-instant.
4. Verify:

   ```bash
   dig comfyui-mcp.artokun.io @drake.ns.cloudflare.com +short   # should now return Cloudflare IPs
   curl -I https://comfyui-mcp.artokun.io/docs                  # HTTP/2 200
   curl -I https://comfyui-mcp.artokun.io/                      # HTTP/2 302 → /docs
   ```

If `curl` returns 404 from a Cloudflare server, the DNS is fixed but the
Worker route is missing — re-run `wrangler deploy`.
