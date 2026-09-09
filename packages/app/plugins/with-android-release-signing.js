const { withAppBuildGradle } = require("expo/config-plugins");

const RELEASE_SIGNING_MARKER = "// Paseo release signing";

const RELEASE_SIGNING_BLOCK = `${RELEASE_SIGNING_MARKER} (managed by with-android-release-signing)
// Reads the release keystore from the environment at Gradle execution time so
// no secret is baked into the generated project. When PASEO_ANDROID_KEYSTORE_PATH
// is unset (local dev), the default Expo signing stays untouched.
def paseoReleaseKeystorePath = System.getenv("PASEO_ANDROID_KEYSTORE_PATH")
if (paseoReleaseKeystorePath) {
    android {
        signingConfigs {
            paseoRelease {
                storeFile file(paseoReleaseKeystorePath)
                storePassword System.getenv("PASEO_ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("PASEO_ANDROID_KEY_ALIAS")
                keyPassword System.getenv("PASEO_ANDROID_KEY_PASSWORD")
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.paseoRelease
            }
        }
    }
}
`;

function configureReleaseSigningAppBuildGradle(contents) {
  if (contents.includes(RELEASE_SIGNING_MARKER)) {
    return contents;
  }

  return `${contents.trimEnd()}\n\n${RELEASE_SIGNING_BLOCK}`;
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = configureReleaseSigningAppBuildGradle(
      modConfig.modResults.contents,
    );
    return modConfig;
  });
}

module.exports = withAndroidReleaseSigning;
module.exports.configureReleaseSigningAppBuildGradle = configureReleaseSigningAppBuildGradle;
