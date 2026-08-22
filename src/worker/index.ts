import { app } from "./api";
import { runScheduledChecks } from "./scheduler";

export default {
  fetch: app.fetch,
  async scheduled(controller, env): Promise<void> {
    await runScheduledChecks(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
