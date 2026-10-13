"""Package only the prepared iOS Xcode project, never the workspace/photos."""
from pathlib import Path
import hashlib
import json
import zipfile
import plistlib

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
release = root / 'releases' / 'ios'
release.mkdir(parents=True, exist_ok=True)
target = release / f'HeadUp-{version}-iOS-Xcode.zip'
info = plistlib.loads((root / 'ios/App/App/Info.plist').read_bytes())
assert info['NSCameraUsageDescription']
assert (root / 'ios/App/App/public/index.html').is_file()
pbx = (root / 'ios/App/App.xcodeproj/project.pbxproj').read_text(encoding='utf-8')
assert f'MARKETING_VERSION = {version};' in pbx
assert 'HeadUpBridgeViewController.swift in Sources' in pbx
excluded = {'DerivedData', 'build', 'Pods', 'output', 'xcuserdata', '.git', '.DS_Store'}
files = [(p, p.relative_to(root).as_posix()) for p in (root / 'ios').rglob('*')
         if p.is_file() and not any(x in excluded for x in p.relative_to(root / 'ios').parts)]
files += [(root / '构建iOS.command', '构建iOS.command'),
          (root / 'docs/IOS.md', 'README.md'),
          (root / 'docs/MODEL-ASSETS.md', 'MODEL-ASSETS.md')]
for p, name in files:
    assert not p.is_symlink()
    assert not any(s in name.lower() for s in ['.p12', '.mobileprovision', '.env', '.sqlite', '.keystore', 'codex-clipboard', 'youth-review', 'drawing-review'])
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for p, name in sorted(files, key=lambda item: item[1]):
        if name.endswith('.command'):
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = (0o100755 << 16)
            z.writestr(entry, p.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        else:
            z.write(p, name)
with zipfile.ZipFile(target) as z:
    assert z.testzip() is None
sha = hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix('.sha256').write_text(f'{sha}  {target.name}\n', encoding='utf-8')
(release / 'build-info.json').write_text(json.dumps({
    'version': version, 'appId': 'com.headup.growth', 'date': '2026-10-09',
    'artifact': target.name, 'status': 'xcode_project_not_natively_compiled_or_signed',
    'bytes': target.stat().st_size, 'sha256': sha, 'files': len(files),
    'minimumIOSConfigured': '17.0', 'requires': 'Mac and Xcode 26+, Apple signing for device installation'
}, indent=2) + '\n', encoding='utf-8')
print(f'Xcode project (NOT IPA): {target}\nBytes: {target.stat().st_size}\nSHA-256: {sha}')
