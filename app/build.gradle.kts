plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystorePath: String? = System.getenv("SIGNING_KEYSTORE")

android {
    namespace = "se.jonsolberg.hxstomp"
    compileSdk = 35

    defaultConfig {
        applicationId = "se.jonsolberg.hxstomp"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "0.2.3"
    }

    signingConfigs {
        create("release") {
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storePassword = System.getenv("SIGNING_STORE_PASSWORD")
                keyAlias = System.getenv("SIGNING_KEY_ALIAS")
                keyPassword = System.getenv("SIGNING_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keystorePath != null) signingConfigs.getByName("release")
            else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // The app shows the same editor as the web version: ../web is bundled as the app's assets.
    sourceSets {
        getByName("main") {
            assets.srcDirs("../web")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")

    testImplementation("junit:junit:4.13.2")
}
