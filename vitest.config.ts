import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          SMTP_USERNAME: "test-user",
          SMTP_PASSWORD: "test-password",
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
