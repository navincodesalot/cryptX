/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */

/** @type {import("next").NextConfig} */
const config = {
  rewrites() {
    return [
      { source: "/log", destination: "/api/log" },
      { source: "/logs", destination: "/api/logs" },
      { source: "/logs/:id", destination: "/api/logs/:id" },
      {
        source: "/security/blacklist",
        destination: "/api/security/blacklist",
      },
      {
        source: "/security/analyze",
        destination: "/api/security/analyze",
      },
      { source: "/audit/report", destination: "/api/audit/report" },
    ];
  },
};

export default config;
