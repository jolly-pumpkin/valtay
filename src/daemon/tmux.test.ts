import { test, expect, describe, afterEach } from "bun:test";
import { $ } from "bun";
import { createSession, hasSession, killSession, attachCommand } from "./tmux.ts";

const SESSION = `valtay-test-${process.pid}`;

async function tmuxAvailable(): Promise<boolean> {
  return (await $`which tmux`.nothrow().quiet()).exitCode === 0;
}

afterEach(async () => {
  if (await tmuxAvailable()) {
    await $`tmux kill-session -t ${SESSION}`.nothrow().quiet();
  }
});

describe("tmux helpers", () => {
  test("hasSession returns false for a nonexistent session", async () => {
    if (!(await tmuxAvailable())) return; // skip without tmux
    expect(await hasSession(SESSION)).toBe(false);
  });

  test("createSession + hasSession + killSession lifecycle", async () => {
    if (!(await tmuxAvailable())) return; // skip without tmux
    await createSession(SESSION, "sleep 60");
    expect(await hasSession(SESSION)).toBe(true);

    await killSession(SESSION);
    expect(await hasSession(SESSION)).toBe(false);
  });

  test("killSession is a no-op for a nonexistent session", async () => {
    if (!(await tmuxAvailable())) return; // skip without tmux
    await killSession(SESSION); // should not throw
  });

  test("attachCommand returns the right string", () => {
    expect(attachCommand("valtay-demo")).toBe("tmux attach -t valtay-demo");
  });
});
