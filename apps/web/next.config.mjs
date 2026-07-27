/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the on-prem Docker image small (ADR-0008).
  output: 'standalone',
  // The web tier is a rendering tier: it must never gain data-layer access.
  // API_INTERNAL_URL is intentionally NOT exposed to the browser.
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
