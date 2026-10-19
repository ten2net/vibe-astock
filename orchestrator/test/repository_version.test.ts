import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repositoryVersion } from "../src/repository_version.ts";

test("source archive does not discover or invoke Git from its parent checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-version-"));
  try {
    fs.mkdirSync(path.join(root, ".git"));
    const archive = path.join(root, "installed", "app");
    fs.mkdirSync(archive, { recursive: true });
    const never = (() => { throw new Error("Git must not run for an archive"); }) as typeof spawnSync;
    assert.equal(repositoryVersion(archive, never), "source-archive(no-git)");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("checkout revision is one bounded noninteractive Git query; failure is explicit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-version-"));
  try {
    // Worktrees use a .git file rather than a directory.
    fs.writeFileSync(path.join(root, ".git"), "gitdir: test-only");
    const sha = "a".repeat(40);
    let calls = 0;
    const run = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls++;
      assert.equal(cmd, "git");
      assert.deepEqual(args, ["rev-parse", "--verify", "-q", "HEAD"]);
      assert.equal(opts.cwd, root);
      assert.equal(opts.timeout, 2000);
      assert.equal(opts.killSignal, "SIGKILL");
      assert.deepEqual(opts.stdio, ["ignore", "pipe", "ignore"]);
      return { status: 0, stdout: sha + "\n" };
    }) as typeof spawnSync;
    assert.equal(repositoryVersion(root, run), sha);
    assert.equal(calls, 1);
    for (const result of [
      { status: null, signal: "SIGKILL", stdout: "", error: new Error("ETIMEDOUT") },
      { status: 1, stdout: "" }, { status: 0, stdout: "not a commit" },
      { status: 0, stdout: sha, error: new Error("spawn error") },
    ]) assert.equal(repositoryVersion(root, (() => result) as unknown as typeof spawnSync), "unknown(git-unavailable)");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
