import { describe, expect, it } from "vitest";

const { configureReleaseSigningAppBuildGradle } = require("./with-android-release-signing");

describe("withAndroidReleaseSigning", () => {
  it("appends an env-based release signing block without touching existing signing", () => {
    const source = [
      "android {",
      "    signingConfigs {",
      "        debug {",
      "            storeFile file('debug.keystore')",
      "        }",
      "    }",
      "    buildTypes {",
      "        release {",
      "            signingConfig signingConfigs.debug",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n");

    const configured = configureReleaseSigningAppBuildGradle(source);

    expect(configured).toContain("// Paseo release signing");
    expect(configured).toContain('System.getenv("PASEO_ANDROID_KEYSTORE_PATH")');
    expect(configured).toContain("signingConfig signingConfigs.paseoRelease");
    expect(configured).toContain("signingConfig signingConfigs.debug");
    expect(configureReleaseSigningAppBuildGradle(configured)).toBe(configured);
  });
});
