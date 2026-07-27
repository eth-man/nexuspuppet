/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the on-prem Docker image small (ADR-0008).
  output: 'standalone',
  // The web tier is a rendering tier: it must never gain data-layer access.
  // API_INTERNAL_URL is intentionally NOT exposed to the browser.
  typedRoutes: true,
  // The dev indicator defaults to the bottom-left, directly on top of the
  // sidebar's Sign out and Collapse controls. Dev-only, but it makes the
  // console unusable exactly where it is being reviewed.
  devIndicators: { position: 'bottom-right' },
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
  allowedDevOrigins: [
    // Matched literally, so the loopback aliases must all be listed: browsing
    // via 127.0.0.1 is otherwise blocked even though `localhost` is allowed,
    // and the page then renders but never hydrates.
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...(process.env.WEB_DEV_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  ],
};

export default nextConfig;
