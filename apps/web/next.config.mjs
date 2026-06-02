/**
 * Next.js config for the web-only console (frontend-console + multi-target-deploy).
 *
 * The web app is deployed to Vercel and bundles NO WebSocket server (D10); it
 * reaches the api strictly over the env-configured cross-origin API_BASE_URL /
 * WS_URL. `@cap/ui` and `@cap/contracts` are workspace packages compiled here.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@cap/ui", "@cap/contracts"],
};

export default nextConfig;
