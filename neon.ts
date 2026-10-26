import { defineConfig } from "@neon/config/v1";

// Neon is used here only as the host for Lakebase Postgres. The app's auth,
// storage, functions and realtime needs are handled by the application itself,
// so none of the optional Neon services are declared.
export default defineConfig({});