/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the on-prem Docker image small (ADR-0008).
  output: 'standalone',
  // The web tier is a rendering tier: it must never gain data-layer access.
  // API_INTERNAL_URL is intentionally NOT exposed to the browser.
  typedRoutes: true,
  /**
   * DEVELOPMENT ONLY.
   *
   * Next blocks requests for dev resources (HMR, the devtools bundle) from any
   * origin other than localhost. Reaching the dev server from another machine —
   * which is the normal case for an ops console being reviewed on a laptop —
   * therefore serves the page but never finishes wiring up the client, and it
   * appears to hang on whatever the server rendered.
   *
   * Set WEB_DEV_ORIGINS to the host or IP you browse from, comma-separated.
   * This has no effect on a production build.
   */
  allowedDevOrigins: (process.env.WEB_DEV_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
};

export default nextConfig;
