# HTML 页面目录

正式构建 `pnpm build` 仅生成 dist/index.html。研究构建 `pnpm build:research` 输出到 dist-research，包含主入口与 tests/pages、research/pages 下的76个页面，不注册PWA服务工作线程。日常开发服务器可按新路径访问页面；原根目录旧链接不再使用。

研究测试需要的私人或外部数据集不纳入GitHub。在本项目的本机 data/ 目录准备授权数据；默认应用和单元测试无需这些数据。研究报告的“无数据”不等于应用检测失败。

两份历史分析报告移动到 .local-archive/reports/ 并停止Git跟踪；新生成的头像分析报告也写入这里。Git旧提交中的文件仍保留，不改写历史。原始独立项目 HeadUp 保留原样。

手动单文件导出使用 `pnpm build:single-pages`，输出目录 single-file-pages 已忽略。导出入口路径与源码分类一致。其本地依赖 tools/vendor/vite-plugin-singlefile 附带原有许可，补齐了先前快照缺失的依赖。

## 原路径与新路径

| 原根目录文件 | 新位置 |
|---|---|
| `app-only-storage-qa.html` | `tests/pages/app-only-storage-qa.html` |
| `avatar-smoke-ffhq-highres-analysis.html` | `.local-archive/reports/avatar-smoke-ffhq-highres-analysis.html` |
| `avatar-smoke-nasa-highres-analysis.html` | `.local-archive/reports/avatar-smoke-nasa-highres-analysis.html` |
| `benchmark-active-challenge.html` | `research/pages/benchmark-active-challenge.html` |
| `benchmark-angle-challenge.html` | `research/pages/benchmark-angle-challenge.html` |
| `benchmark-anti-spoof-mn3.html` | `research/pages/benchmark-anti-spoof-mn3.html` |
| `benchmark-avatar-full-pipeline.html` | `research/pages/benchmark-avatar-full-pipeline.html` |
| `benchmark-avatar-robustness.html` | `research/pages/benchmark-avatar-robustness.html` |
| `benchmark-avif-format.html` | `research/pages/benchmark-avif-format.html` |
| `benchmark-capture-performance.html` | `research/pages/benchmark-capture-performance.html` |
| `benchmark-celeba-expression.html` | `research/pages/benchmark-celeba-expression.html` |
| `benchmark-cew-eye-closure-highres.html` | `research/pages/benchmark-cew-eye-closure-highres.html` |
| `benchmark-cew-eye-closure.html` | `research/pages/benchmark-cew-eye-closure.html` |
| `benchmark-cmu-sunglasses.html` | `research/pages/benchmark-cmu-sunglasses.html` |
| `benchmark-demographic-coverage.html` | `research/pages/benchmark-demographic-coverage.html` |
| `benchmark-exif-orientation.html` | `research/pages/benchmark-exif-orientation.html` |
| `benchmark-exposure-avif.html` | `research/pages/benchmark-exposure-avif.html` |
| `benchmark-exposure-encoding.html` | `research/pages/benchmark-exposure-encoding.html` |
| `benchmark-exposure-exif.html` | `research/pages/benchmark-exposure-exif.html` |
| `benchmark-exposure-external.html` | `research/pages/benchmark-exposure-external.html` |
| `benchmark-exposure-fairface.html` | `research/pages/benchmark-exposure-fairface.html` |
| `benchmark-exposure-highlight-calibration.html` | `research/pages/benchmark-exposure-highlight-calibration.html` |
| `benchmark-exposure-highlight-london.html` | `research/pages/benchmark-exposure-highlight-london.html` |
| `benchmark-exposure-icc.html` | `research/pages/benchmark-exposure-icc.html` |
| `benchmark-exposure-position.html` | `research/pages/benchmark-exposure-position.html` |
| `benchmark-fairface.html` | `research/pages/benchmark-fairface.html` |
| `benchmark-front-canvas-perturbation.html` | `research/pages/benchmark-front-canvas-perturbation.html` |
| `benchmark-front-mirror.html` | `research/pages/benchmark-front-mirror.html` |
| `benchmark-front.html` | `research/pages/benchmark-front.html` |
| `benchmark-icc-color-encoding.html` | `research/pages/benchmark-icc-color-encoding.html` |
| `benchmark-image-format-parity.html` | `research/pages/benchmark-image-format-parity.html` |
| `benchmark-lowlight-fairface.html` | `research/pages/benchmark-lowlight-fairface.html` |
| `benchmark-menpo-front.html` | `research/pages/benchmark-menpo-front.html` |
| `benchmark-muct.html` | `research/pages/benchmark-muct.html` |
| `benchmark-nuaa-print-attack.html` | `research/pages/benchmark-nuaa-print-attack.html` |
| `benchmark-openimages-glasses.html` | `research/pages/benchmark-openimages-glasses.html` |
| `benchmark-openimages-sunglasses.html` | `research/pages/benchmark-openimages-sunglasses.html` |
| `benchmark-openvino-eye-state.html` | `research/pages/benchmark-openvino-eye-state.html` |
| `benchmark-physical-replay.html` | `research/pages/benchmark-physical-replay.html` |
| `benchmark-profile.html` | `research/pages/benchmark-profile.html` |
| `benchmark-quality-boundary.html` | `research/pages/benchmark-quality-boundary.html` |
| `benchmark-quality-runtime-parity.html` | `research/pages/benchmark-quality-runtime-parity.html` |
| `benchmark-quality-upscale-browser.html` | `research/pages/benchmark-quality-upscale-browser.html` |
| `benchmark-real-occlusion.html` | `research/pages/benchmark-real-occlusion.html` |
| `benchmark-robustness.html` | `research/pages/benchmark-robustness.html` |
| `benchmark-silent-face-pad.html` | `research/pages/benchmark-silent-face-pad.html` |
| `benchmark-wflw-contour-calibration.html` | `research/pages/benchmark-wflw-contour-calibration.html` |
| `benchmark-wflw-front.html` | `research/pages/benchmark-wflw-front.html` |
| `family-account-qa.html` | `tests/pages/family-account-qa.html` |
| `family-ai-qa.html` | `tests/pages/family-ai-qa.html` |
| `family-audit-qa.html` | `tests/pages/family-audit-qa.html` |
| `family-baseline-qa.html` | `tests/pages/family-baseline-qa.html` |
| `family-camera-qa.html` | `tests/pages/family-camera-qa.html` |
| `family-compare-qa.html` | `tests/pages/family-compare-qa.html` |
| `family-handoff-qa.html` | `tests/pages/family-handoff-qa.html` |
| `family-handoff-responsive-qa.html` | `tests/pages/family-handoff-responsive-qa.html` |
| `family-plan-qa.html` | `tests/pages/family-plan-qa.html` |
| `family-responsive-qa.html` | `tests/pages/family-responsive-qa.html` |
| `family-share-qa.html` | `tests/pages/family-share-qa.html` |
| `family-storage-qa.html` | `tests/pages/family-storage-qa.html` |
| `family-sync-qa.html` | `tests/pages/family-sync-qa.html` |
| `family-volume-qa.html` | `tests/pages/family-volume-qa.html` |
| `front-profile-visual-regression.html` | `research/pages/front-profile-visual-regression.html` |
| `manual-back-head-review.html` | `research/pages/manual-back-head-review.html` |
| `manual-regression-review.html` | `research/pages/manual-regression-review.html` |
| `manual-top-contour-review.html` | `research/pages/manual-top-contour-review.html` |
| `research-active-challenge.html` | `research/pages/research-active-challenge.html` |
| `research-fei-yaw-threshold.html` | `research/pages/research-fei-yaw-threshold.html` |
| `research-local-occlusion.html` | `research/pages/research-local-occlusion.html` |
| `research-local-retake.html` | `research/pages/research-local-retake.html` |
| `research-menton-annotation.html` | `research/pages/research-menton-annotation.html` |
| `research-profile-assisted-review.html` | `research/pages/research-profile-assisted-review.html` |
| `research-profile-geometry-crosscheck.html` | `research/pages/research-profile-geometry-crosscheck.html` |
| `research-profile-neck-aesthetic-rating.html` | `research/pages/research-profile-neck-aesthetic-rating.html` |
| `research-profile-region-annotation.html` | `research/pages/research-profile-region-annotation.html` |
| `research-progress.html` | `research/pages/research-progress.html` |
| `wikimedia-profile-manual-review.html` | `research/pages/wikimedia-profile-manual-review.html` |
| `wikimedia-profile-regression.html` | `research/pages/wikimedia-profile-regression.html` |
| `骨相工具技术方案.html` | `docs/design/骨相工具技术方案.html` |

## 本次验证（2026-10-19）

- TypeScript 检查通过；117个测试文件、729项测试通过。
- 正式构建 dist/ 只有 index.html；研究构建含77个HTML入口（主入口+76个工具页）。
- `node scripts/check-page-layout.mjs` 检查页面入口、模块和静态页面链接，结果通过。
- 单文件导出14个页面全部通过内联脚本与样式校验。
- 应用界面、照片存储策略和测量流程未修改；本次未重新生成Android APK。
