/**
 * Node-side stub for the `server-only` marker.
 *
 * The real package throws unless it is imported inside a React Server
 * Component graph, which is exactly what a CLI script is not. This alias is only
 * wired up in tsconfig.scripts.json, so the Next build keeps the real guard.
 */
export {};
