import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_PATH, SOURCE_ROOT } from "./paths.mjs";

function nodeRunner(script, args) {
  return spawnSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    encoding: "utf8",
  });
}

function checked(run, script, args) {
  const result = run(script, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${script} exited with status ${result.status ?? "unknown"}` +
        `${result.stderr ? `: ${result.stderr.trim()}` : "."}`,
    );
  }
  return result;
}

function restoreTransport(run, signed) {
  checked(run, "config-manager.mjs", ["enable"]);
  if (signed) checked(run, "config-manager.mjs", ["signed-enable"]);
  checked(run, "catalog.mjs", []);
}

export function reconcileConfig(run = nodeRunner) {
  checked(run, "config-manager.mjs", ["reconcile"]);
}

export function observeConfig({
  run = nodeRunner,
  watchImpl = watch,
  delayMs = 200,
  report = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        reconcileConfig(run);
      } catch (error) {
        report(
          `[codex-router] config lifecycle reconciliation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, delayMs);
  };
  const watcher = watchImpl(path.dirname(CONFIG_PATH), (_event, filename) => {
    if (filename == null || String(filename) === path.basename(CONFIG_PATH)) schedule();
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

export function installSignalRecovery(
  restore,
  {
    signalTarget = process,
    exit = (code) => process.exit(code),
    report = (message) => process.stderr.write(`${message}\n`),
  } = {},
) {
  let active = true;
  const exitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  const handlers = new Map(
    Object.keys(exitCodes).map((signal) => [
      signal,
      () => {
        if (!active) return;
        active = false;
        for (const [name, handler] of handlers) signalTarget.removeListener(name, handler);
        try {
          restore();
        } catch {
          report("Catalog refresh was interrupted and the routing transport could not be restored.");
        }
        exit(exitCodes[signal]);
      },
    ]),
  );
  for (const [signal, handler] of handlers) signalTarget.on(signal, handler);
  return () => {
    if (!active) return;
    active = false;
    for (const [signal, handler] of handlers) signalTarget.removeListener(signal, handler);
  };
}

export function refreshCatalog({
  run = nodeRunner,
  recoveryInstaller = run === nodeRunner ? installSignalRecovery : undefined,
} = {}) {
  const statusResult = checked(run, "config-manager.mjs", ["status"]);
  let status;
  try {
    status = JSON.parse(statusResult.stdout);
  } catch {
    throw new Error("config-manager.mjs status returned invalid JSON.");
  }
  const routed = status.mode === "router";
  const signed = status.signed_routing === true;
  let restoreNeeded = false;
  let removeSignalRecovery;
  let catalogResult;
  try {
    if (routed) {
      checked(run, "config-manager.mjs", ["disable"]);
      restoreNeeded = true;
      removeSignalRecovery = recoveryInstaller?.(() => {
        if (!restoreNeeded) return;
        restoreNeeded = false;
        restoreTransport(run, signed);
      });
    }
    catalogResult = checked(run, "catalog.mjs", ["--refresh-native"]);
    if (restoreNeeded) {
      restoreTransport(run, signed);
      restoreNeeded = false;
    }
  } catch (error) {
    if (restoreNeeded) {
      try {
        restoreTransport(run, signed);
        restoreNeeded = false;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Catalog refresh failed and the previous routing transport could not be restored.",
        );
      }
    }
    throw error;
  } finally {
    removeSignalRecovery?.();
  }
  return { catalogOutput: catalogResult.stdout || "" };
}

function main() {
  const { catalogOutput } = refreshCatalog();
  if (catalogOutput) process.stdout.write(catalogOutput);
  process.stdout.write("Native and external model catalogs refreshed. Fully quit and reopen Codex.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
