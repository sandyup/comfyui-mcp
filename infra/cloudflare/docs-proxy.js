/**
 * Cloudflare Worker: serve the Mintlify docs at comfyui-mcp.artokun.io/docs
 * by reverse-proxying to the Mintlify deployment, while everything else on the
 * host falls through to its normal origin.
 *
 * Requirements for this to render correctly:
 *  - Mintlify project's custom domain/subpath is set to comfyui-mcp.artokun.io/docs
 *    (so assets/links are generated with the /docs prefix).
 *  - A proxied (orange-cloud) DNS record exists for comfyui-mcp.artokun.io on the
 *    artokun.io zone so the route below can fire.
 *
 * Deploy: cd infra/cloudflare && npx wrangler deploy
 */
const DOCS_HOST = "artokun.mintlify.dev";
const PUBLIC_HOST = "comfyui-mcp.artokun.io";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Bare root → the docs. 302 (temporary) so it's easy to swap for a real
    // landing page later without fighting cached permanent redirects.
    if (url.pathname === "/" || url.pathname === "") {
      return Response.redirect(`https://${PUBLIC_HOST}/docs`, 302);
    }

    // Proxy /docs and everything under it to Mintlify.
    if (/^\/docs(\/|$)/.test(url.pathname)) {
      url.hostname = DOCS_HOST;
      const proxied = new Request(url, request);
      proxied.headers.set("Host", DOCS_HOST);
      proxied.headers.set("X-Forwarded-Host", PUBLIC_HOST);
      proxied.headers.set("X-Forwarded-Proto", "https");
      return fetch(proxied);
    }

    // Anything else: pass through to the normal origin.
    return fetch(request);
  },
};
