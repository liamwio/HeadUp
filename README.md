# HeadUp

面部轮廓记录与变化观察应用，包含 React 网页前端、Capacitor Android 工程和 iOS 工程。

当前主版本为 **1.1.12-apponly**：照片和分析记录保存在应用内，不自动复制到手机相册或共享目录。用户主动导出备份的功能保留。至少三次记录后自动形成趋势报告；测量遵循“关键点 → 绘线 → 读数”，不同测量来源不混算。

## 开发环境

- Node.js 24.12.0 或更高版本（`.nvmrc` 给出验证版本）。
- pnpm 11.25.0（已在 `package.json` 固定；可用 Corepack 或自行安装该版本）。
- Android：JDK 21、SDK Platform 36、Build Tools 36.0.0、Platform Tools。
- iOS：Mac、Xcode 和 Apple 签名条件；Windows 只能准备工程，不能生成可安装 IPA。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Vite 在终端打印网页地址。个人档案、照片分析和相机在本机处理；使用相机需要 localhost 或 HTTPS 安全上下文。

## 验证与构建

```sh
corepack pnpm exec vitest run --maxWorkers=4
corepack pnpm build
```

网页产物位于 `dist/`，仅包含正式应用入口。测试与研究页面另行构建：

```sh
corepack pnpm build:research
corepack pnpm preview:research
corepack pnpm check:pages
```

研究构建输出在 `dist-research/`；日常 `pnpm dev` 也可直接访问 `/tests/pages/…` 和 `/research/pages/…`。

本机验证基线：117 个测试文件、729 项测试。研究页需要的外部数据集不在仓库内，相关基准命令不等同于默认单元测试。

Android 构建前设置 `JAVA_HOME` 及 `ANDROID_HOME`（或 `ANDROID_SDK_ROOT`），指向自己的工具安装位置；也支持项目下 `.android-tools/` 本地工具目录，但该目录不会上传。

```sh
corepack pnpm android:build
```

构建会进行 TypeScript 检查、Android 前端构建、Capacitor 同步、Gradle 编译、单元测试和 lint，产物位于 `releases/android/`。当前脚本生成调试签名测试包；换电脑的默认调试签名可能不同，不能据此保证覆盖已有安装。签名私钥不随源码上传。

iOS 工程资源准备：`corepack pnpm ios:prepare`。完整编译需要上述 Mac/Xcode 条件。

## 代码目录

| 目录 | 内容 |
|---|---|
| `src/family/` | 档案、记录、时间线、趋势和本机数据管理 |
| `src/lib/` | 拍摄质量、姿态、关键点、几何测量 |
| `src/android/` | Android 前端入口与原生桥接适配 |
| `android/`、`ios/` | 原生工程 |
| `server/` | 可选自托管服务；个人模式下家庭功能关闭 |
| `public/models/`、`public/mediapipe/` | 本机推理资源及现有许可说明 |
| `tests/pages/` | 浏览器验收入口 |
| `research/pages/` | 研究、基准测试及人工复核入口 |
| `research/`、`scripts/` | 研究工具、回归检查和构建脚本 |
| `docs/` | 平台说明与源码维护说明 |

## 数据和配置

- 本仓库不包含儿童原始照片、用户档案数据库、导出的个人报告、API 密钥、SDK、依赖缓存或 APK。
- `.env*.example` 是配置模板。真实配置使用被忽略的 `.env*.local` 文件；不要把密钥写进前端源码。
- 私人测试数据只能保留在本机。仓库内图标、取景插画和模型资源用于应用运行。
- 已有应用内历史格式保持不变；旧版手机共享目录副本不会被自动删除。应用数据与浏览器数据彼此独立。
- 清除应用数据或卸载可能删除应用内照片；按需使用应用提供的加密备份功能。

## 版本与维护

GitHub `main` 和 `app-only-photos` 初始均指向整理后的应用内保存版。原先支持手机目录复制的源码保留在本机独立项目，未作为当前默认功能启用。

源码维护见 [开发说明](docs/DEVELOPMENT.md)，Android 分支说明见 [Android](docs/ANDROID.md)。仓库按私有项目管理，未新增开源授权；第三方组件和模型遵循各自许可，代码许可与模型权重许可需分别核对。

照片中可见轮廓的测量不等于骨骼或健康诊断。自动提示和趋势读数仍受拍摄角度、距离、光线及模型误差影响。

根目录仅保留 `index.html`。设计文档位于 `docs/design/`；自动生成的历史分析报告保留在本机 `.local-archive/reports/`，不再作为源码跟踪。详细映射见 [页面目录](docs/PAGES.md)。
