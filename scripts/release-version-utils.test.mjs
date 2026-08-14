import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNextReleaseVersion,
  getReleaseInfoFromSourceTag,
  normalizeReleaseTag,
  parseReleaseVersion,
} from "./release-version-utils.mjs";

test("computes the next beta patch from a stable version", () => {
  assert.equal(computeNextReleaseVersion("0.1.59", "beta-patch"), "0.1.60-beta.1");
});

test("advances beta versions", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.1", "beta-next"), "0.1.60-beta.2");
});

test("promotes beta versions to stable", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.2", "promote"), "0.1.60");
});

test("parses beta release metadata", () => {
  assert.deepEqual(parseReleaseVersion("0.1.60-beta.1"), {
    version: "0.1.60-beta.1",
    major: 0,
    minor: 1,
    patch: 60,
    prerelease: "beta.1",
    baseVersion: "0.1.60",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
  });
});

test("emits beta release info from tags", () => {
  assert.deepEqual(getReleaseInfoFromSourceTag("v0.1.60-beta.1"), {
    sourceTag: "v0.1.60-beta.1",
    releaseTag: "v0.1.60-beta.1",
    version: "0.1.60-beta.1",
    baseVersion: "0.1.60",
    prerelease: "beta.1",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
    releaseType: "prerelease",
    releaseChannel: "beta",
    isSmokeTag: false,
  });
});

test("normalizes legacy dotted beta tags used by manual release runs", () => {
  assert.equal(normalizeReleaseTag("v0.4.0.beta.3"), "v0.4.0-beta.3");
  assert.equal(normalizeReleaseTag("desktop-macos-v0.4.0.beta.3"), "v0.4.0-beta.3");
});

test("normalizes bare version tags (no v prefix)", () => {
  assert.equal(normalizeReleaseTag("0.4.2"), "v0.4.2");
  assert.equal(normalizeReleaseTag("0.4.2-beta.1"), "v0.4.2-beta.1");
  assert.equal(normalizeReleaseTag("desktop-macos-0.4.2"), "v0.4.2");
  assert.equal(normalizeReleaseTag("0.4.0.beta.3"), "v0.4.0-beta.3");
});

test("rejects non-beta prerelease versions", () => {
  assert.throws(() => parseReleaseVersion("0.1.60-canary.1"), /Expected beta prerelease versions/);
});
