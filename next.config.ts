import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Nearly every route here is user-scoped and reads cookies, so Cache
  // Components' uncached-data-in-Suspense rules would apply to essentially every
  // page for no benefit. Auth, attempts, and reports are deliberately dynamic.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // These must stay as real Node requires rather than being bundled:
  //   - PGlite runs Postgres in WebAssembly and resolves paths against a URL from
  //     its own realm, which breaks inside Turbopack's server sandbox.
  //   - pg and react-pdf pull in native/WASM-adjacent dependencies.
  serverExternalPackages: [
    "@electric-sql/pglite",
    "pg",
    "@react-pdf/renderer",
    "@react-pdf/reconciler",
    "fontkit",
  ],
  outputFileTracingIncludes: {
    // Report files and font assets are runtime data, never part of the trace.
    "/**": ["./.reports/**/*", "./public/fonts/**/*"],
  },
};

export default nextConfig;
