#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此脚本需要 Mac 与 Xcode 26 或更高版本。"
  exit 1
fi
xcodebuild -version
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO build
echo "模拟器 App 已生成：ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app"
echo "安装到 iPhone：在 Xcode 打开 ios/App/App.xcodeproj，选择签名团队和连接的 iPhone，然后运行。"
