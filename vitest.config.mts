import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Database integration tests share one disposable Postgres and reset it,
    // so test files must not run at the same time.
    fileParallelism: false,
  },
});
