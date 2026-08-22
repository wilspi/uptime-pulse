import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SITE_NAME: "Uptime Pulse Test",
          SMTP_HOST: "smtp.example.com",
          SMTP_PORT: "465",
          SMTP_FROM: "alerts@example.com",
          SMTP_TO: "recipient@example.com",
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
