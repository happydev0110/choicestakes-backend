import type { FastifyBaseLogger } from "fastify";
import { providerDiagnostic } from "./provider-error.js";

export function createCatalogWorker(
  run: (signal: AbortSignal) => Promise<number>,
  intervalMs: number,
  log: Pick<FastifyBaseLogger, "info" | "warn">,
) {
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  function start() {
    if (stopped || running || timer) return;
    controller = new AbortController();
    const signal = controller.signal;
    running = Promise.resolve()
      .then(() => run(signal))
      .then((total) => {
        if (!signal.aborted)
          log.info(
            { total },
            total
              ? "Provider catalog imported"
              : "Provider returned zero games. Check sandbox currency access and enabled games.",
          );
      })
      .catch((error: unknown) => {
        if (!signal.aborted) log.warn(providerDiagnostic(error));
      })
      .finally(() => {
        running = undefined;
        if (!stopped) {
          timer = setTimeout(() => {
            timer = undefined;
            start();
          }, intervalMs);
          timer.unref();
        }
      });
  }
  async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
    await running;
  }
  return { start, stop };
}
