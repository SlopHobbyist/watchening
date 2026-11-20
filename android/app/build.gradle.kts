import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing: keystore.properties next to settings.gradle.kts (see README.md).
// Without it, release APKs are signed with the debug key so they still install.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val defaultUrl = (findProperty("watchening.url") as String?).orEmpty()

android {
    namespace = "io.github.slophobbyist.watchening"
    // GeckoView needs Android 17 QPR2's APIs to compile against
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "io.github.slophobbyist.watchening"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "DEFAULT_URL", "\"${defaultUrl.replace("\"", "")}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    // One APK per CPU type: GeckoView is big, and many TV boxes run 32-bit
    // Android (armeabi-v7a) even on 64-bit chips.
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    // Compressed native code: GeckoView's libxul is ~120 MB uncompressed, so
    // this roughly halves the APK people download and sideload.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("org.mozilla.geckoview:geckoview-omni:160.0.20261116130455")
}
