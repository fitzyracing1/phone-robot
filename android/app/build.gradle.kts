plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Firebase Cloud Messaging is optional. Drop your google-services.json into app/ to enable push; without it the app
// builds and works the same, getting commands by polling the server.
val fcmEnabled = file("google-services.json").exists()
if (fcmEnabled) apply(plugin = "com.google.gms.google-services")

android {
    namespace = "com.fitzyracing1.phonerobot"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.fitzyracing1.phonerobot"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
        buildConfigField("boolean", "FCM_ENABLED", fcmEnabled.toString())
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
    lint {
        abortOnError = true
        warningsAsErrors = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // Play services pulls in an old androidx.fragment; the Activity Result API needs >= 1.3.0.
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
