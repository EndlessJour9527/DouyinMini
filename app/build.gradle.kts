plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.douyinmini"
    compileSdk = 34

    // APK 输出命名 douyin-glasses（如 douyin-glasses-debug.apk）
    base {
        archivesName.set("douyin-glasses")
    }

    defaultConfig {
        // 与主分支 com.douyinmini 区分：眼镜版可并存安装
        //（applicationId 不允许连字符，douyin-glasses 落地为 com.douyin.glasses）
        applicationId = "com.douyin.glasses"
        minSdk = 24
        targetSdk = 34
        versionCode = 5
        versionName = "1.4.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.activity:activity-ktx:1.8.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
