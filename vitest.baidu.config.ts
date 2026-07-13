import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/adapters/**/*.integration.test.ts"],
    setupFiles: ["test/setup-baidu-contract.ts"],
  },
});
