# DouyinMini · 抖音眼镜播放器

基于 Kotlin 和 Android WebView 的非官方抖音播放器，面向 Android 显示眼镜提供触摸板操作、视频网格、播放历史，以及不使用相机的 3DoF 防抖。

本项目基于 [bailishta/DouyinMini](https://github.com/bailishta/DouyinMini) 继续开发，公开发布分支仅包含脱敏后的源码快照；原项目作者与来源通过链接保留。原项目 README 声明采用 MIT，本仓库补充独立 [LICENSE](LICENSE)。本项目与抖音、字节跳动等第三方厂商无官方隶属关系；第三方商标、视频和服务不属于本项目的许可证范围。

## 项目组成

| 目录 | 用途 | 状态 |
| --- | --- | --- |
| `app/` | Android WebView 主应用，包名 `com.douyin.glasses` | 已在 Android 显示眼镜上验证，详见测试边界 |
| `douyin-aiui-pure/` | 无 WebView 的 AIUI 推荐与播放实验 | Mac 短样本验证，依赖 Ink 运行时 |
| `tests/` | 主应用 JavaScript 选源与画质切换测试 | Node.js 内置测试框架 |
| `docs/` | 眼镜交互、3DoF 设计与设备验证记录 | 区分实测结果与未验证能力 |

纯 AIUI 实验不参与根项目的 Gradle 构建，需要单独提供兼容的 Ink 运行时。

## 主应用能力

- WebView 驻留抖音同源页面，提取网页实际返回的视频元数据，自有播放器支持候选地址容错、预加载、历史与收藏。
- 黑色背景及面向小屏的菜单、网格和播控；支持切换到原网页处理登录或直播。
- 无相机 3DoF：模式 1 原始跟随、模式 2 预测跟随、模式 3 方向锚定；支持独立开关和回正。
- 画质对照开关：开启时优先选择最高 1080P 的 H.264 源，采用 720×570 离屏捕获与边界抗锯齿；关闭时恢复原始 540P 选源、480×380 捕获和原始投影边界。性能调度优化在两档均保留。
- 视频内容更新与头部重投影独立调度，后台停止捕获、GL 与 IMU。

画质档位是选源上限，并非每条视频都提供该分辨率；眼镜物理面板不会因此提高分辨率。方向锚定会漂移，不提供位置跟踪、SLAM、环境遮挡或持久化空间锚。本实现为应用层重投影，不等同于系统级 ATW。

## 环境与构建

主应用需要 JDK 17、Android SDK 34；Gradle Wrapper 为 8.7，最低运行版本为 Android 7.0（API 24）。3DoF 离屏管线需要 Android 10（API 29）及相关传感器，具体限制见源码和设计文档。

在 Android Studio 中打开仓库根目录，或设置本机 SDK 后构建：

```sh
export ANDROID_HOME=/path/to/Android/Sdk
./gradlew assembleDebug
```

也可使用未纳入版本控制的 `local.properties` 设置 `sdk.dir`。首次构建需要联网下载 Gradle 和依赖。

APK：`app/build/outputs/apk/debug/douyin-glasses-debug.apk`。

```sh
adb -s <device-serial> install -r app/build/outputs/apk/debug/douyin-glasses-debug.apk
adb -s <device-serial> shell am start -n com.douyin.glasses/com.douyinmini.MainActivity
```

此处构建的是调试包；仓库不包含发布签名、预构建 APK 或当前版本的 Release 下载承诺。发布包需自行签名。

## 验证

需要 Node.js 18 或更新版本运行 JavaScript 测试：

```sh
./gradlew assembleDebug testDebugUnitTest lintDebug
node --test tests/*.test.cjs
(cd douyin-aiui-pure && node --test tests/*.test.cjs)
```

JavaScript 测试不需要 Ink 运行时；纯 AIUI 播放效果和网络接口可用性需单独验证。

主应用曾在 Android 显示眼镜、Android 14、480×380 / 60Hz 屏幕上进行短时实测：GL 提交约 59–60fps，视频捕获通常约 28–30fps。这些不是光学延迟测量；长时间温升、续航、边界闪烁与不同视频源仍需进一步验证。防抖开关的严格功耗增量尚未测定。

## 眼镜操作

| 输入 | 播放页 | 菜单 / 网格 |
| --- | --- | --- |
| 单指单击 | 播放 / 暂停 | 激活聚焦项 |
| 单指双击 | 打开视频网格 | 返回播放器 |
| 单指前滑 / 后滑 | 下一条 / 上一条 | 移动焦点 |
| 单指长按 | 打开快捷菜单 | 切换菜单 |
| 双指双击 | 收藏 / 取消收藏 | 收藏 / 取消收藏 |
| 功能键单击 | 静音 / 取消静音 | 同左 |
| 摘下眼镜 / 折叠镜腿 | 暂停播放 | 暂停播放 |

快捷菜单内可切换防抖、模式、回正和画质。实际按键广播因设备与固件而异，详见 [眼镜适配记录](docs/glasses-integration.md)。

## 架构与文档

WebView 同源响应 → JavaScript 视频队列与播放器 → 原生手势及本地状态。开启防抖后，WebView 内容经 RenderNode / HardwareRenderer 捕获到 SurfaceTexture，独立 GL 线程根据 IMU 姿态重投影到 SurfaceView。

- [3DoF 三模式、预测与画质开关](docs/3dof-xr-design.md)
- [性能问题与验证记录](docs/3dof-performance.md)
- [眼镜交互和网页适配](docs/glasses-integration.md)
- [贡献与复现方法](CONTRIBUTING.md)

## 数据与第三方服务

登录 Cookie 由设备 WebView 管理；观看历史、收藏和播放进度保存在应用本地。不要提交真实 Cookie、访问令牌、完整带签名媒体地址、设备日志或应用数据备份。网页接口、登录要求和 CDN 授权可能变化，本项目不保证服务长期可用，不提供绕过内容授权的能力。请仅在有权访问内容的范围内使用，并遵守相关服务条款。
