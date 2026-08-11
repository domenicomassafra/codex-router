import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  installSignalRecovery,
  observeConfig,
  reconcileConfig,
  refreshCatalog,
} from "../src/refresh-catalog.mjs";

function recordingRunner({ signed = true, failAt } = {}) {
  const calls = [];
  return {
    calls,
    run(script, args) {
      calls.push([script, args]);
      const index = calls.length;
      if (index === failAt) {
        return { status: 75, stdout: "", stderr: "forced catalog failure" };
      }
      if (script === "config-manager.mjs" && args[0] === "status") {
        return {
          status: 0,
          stdout: `${JSON.stringify({ mode: "router", signed_routing: signed })}\n`,
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: script === "catalog.mjs" ? '{"models":1}\n' : "",
        stderr: "",
      };
    },
  };
}

test("refresh orchestration restores signed routing and republishes the routed catalog", () => {
  const runner = recordingRunner();
  const result = refreshCatalog({ run: runner.run });
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    ["config-manager.mjs", ["disable"]],
    ["catalog.mjs", ["--refresh-native", "--bundled-native"]],
    ["config-manager.mjs", ["enable"]],
    ["config-manager.mjs", ["signed-enable"]],
    ["catalog.mjs", []],
  ]);
  assert.equal(result.catalogOutput, '{"models":1}\n');
});

test("refresh orchestration restores the active transport after catalog failure", () => {
  const runner = recordingRunner({ failAt: 3 });
  assert.throws(
    () => refreshCatalog({ run: runner.run }),
    /catalog\.mjs exited with status 75.*forced catalog failure/s,
  );
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    ["config-manager.mjs", ["disable"]],
    ["catalog.mjs", ["--refresh-native", "--bundled-native"]],
    ["config-manager.mjs", ["enable"]],
    ["config-manager.mjs", ["signed-enable"]],
    ["catalog.mjs", []],
  ]);
});

test("ordinary routed refresh also republishes external models after restore", () => {
  const runner = recordingRunner({ signed: false });
  refreshCatalog({ run: runner.run });
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    ["config-manager.mjs", ["disable"]],
    ["catalog.mjs", ["--refresh-native", "--bundled-native"]],
    ["config-manager.mjs", ["enable"]],
    ["catalog.mjs", []],
  ]);
});

test("an interrupted refresh restores routing before exiting", () => {
  const signals = new EventEmitter();
  const exits = [];
  const reports = [];
  let restores = 0;
  installSignalRecovery(
    () => {
      restores += 1;
    },
    {
      signalTarget: signals,
      exit: (code) => exits.push(code),
      report: (message) => reports.push(message),
    },
  );

  signals.emit("SIGTERM");
  signals.emit("SIGTERM");

  assert.equal(restores, 1);
  assert.deepEqual(exits, [143]);
  assert.deepEqual(reports, []);
});

test("config reconciliation delegates to the canonical config manager", () => {
  const runner = recordingRunner();
  reconcileConfig(runner.run);
  assert.deepEqual(runner.calls, [["config-manager.mjs", ["reconcile"]]]);
});

test("config observation coalesces app lifecycle rewrites", async () => {
  const runner = recordingRunner();
  let notify;
  let closed = 0;
  const stop = observeConfig({
    run: runner.run,
    delayMs: 5,
    watchImpl(_directory, callback) {
      notify = callback;
      return { close: () => (closed += 1) };
    },
  });

  notify("change", "other.toml");
  notify("rename", "config.toml");
  notify("change", "config.toml");
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();

  assert.deepEqual(runner.calls, [["config-manager.mjs", ["reconcile"]]]);
  assert.equal(closed, 1);
});
