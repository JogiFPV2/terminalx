import java.util.Properties

plugins {
    id("com.android.application")
}

// Klucz podpisu wydania: android/keystore.properties (poza repozytorium) albo zmienne środowiskowe w CI.
val signing = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun sig(key: String, env: String): String? = signing.getProperty(key) ?: System.getenv(env)

android {
    namespace = "app.hermitty.phone"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.hermitty.phone"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        create("release") {
            val store = sig("storeFile", "HERMITTY_PHONE_KEYSTORE")
            if (store != null) {
                storeFile = file(store)
                storePassword = sig("storePassword", "HERMITTY_PHONE_KEYSTORE_PASSWORD")
                keyAlias = sig("keyAlias", "HERMITTY_PHONE_KEY_ALIAS") ?: "hermitty"
                keyPassword = sig("keyPassword", "HERMITTY_PHONE_KEY_PASSWORD") ?: storePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (sig("storeFile", "HERMITTY_PHONE_KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("META-INF/**", "kotlin/**", "DebugProbesKt.bin")
    }
}
