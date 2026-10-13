# HeadUp 颅面外观分析 PWA

> 2026-10-09 网页结果页精简：拍摄、核对、报告、趋势四处改为先给一句结论，再给图和数值；指标改通俗名称、数值取整、说明折叠。只改显示层，读数与比较规则不变。见 [实施记录](docs/ui-simplify-2026-10-09/IMPLEMENTATION.md)；剩余待优化项见 [后续优化方案](docs/OPTIMIZATION-PLAN-2026-10-09.md)。本轮未编译 Android。

> 2026-09-22 已按用户要求更新 Android 1.1.4，包含点位语义修正、点线同源测量及三次记录后的自动趋势报告。见 [安装说明](docs/ANDROID.md)。

> 2026-09-22 网页自动趋势：保存至少3次照片记录后自动生成报告并持续更新，移除手动选择两次对比。左右侧独立，来源/条件不足时不强行计算变化。见 [自动趋势说明](docs/AUTOMATIC-TREND-2026-09-22.md)。

> 2026-09-22 自动图片与大模型复核：24张授权成人研究照片，296项可用读数复算一致；模型视觉审查标记7张侧面需核验。见 [完整报告](data/validation/llm-drawing-review-2026-09-22/REPORT.md) 与 [四联图册](data/validation/llm-drawing-review-2026-09-22/gallery.html)。该结果不证明儿童定位或跨期精度。

> 2026-09-22 网页测量改为点线同源：新读数可查看对应关键点、测量线和公式；侧面不再用直接预测值代替点位计算，新旧来源禁止混算。见 [点线测量说明](docs/POINT-LINE-MEASUREMENT-2026-09-22.md)。

> 2026-09-22 网页侧面点序修正：修复眉/眼点被误连为额部和鼻唇线，拆分正确区域，增加异常输出拦截，兼容旧记录显示。见 [语义修复说明](docs/PROFILE-SEMANTIC-FIX-2026-09-22.md)。本轮尚未打包 Android。

> 2026-09-22 网页侧面测绘显示：细线、小屏单列照片、放大查看与隐藏线条对照。见 [显示优化说明](docs/PROFILE-OVERLAY-VIEW-2026-09-22.md)。

> 2026-09-22 网页拍摄更新：新增距离、入镜留白、位置、角度、光线、清晰度实时提示，调整正面与左右侧轮廓框。见 [取景提示说明](docs/LIVE-CAPTURE-GUIDANCE-2026-09-22.md)。

> 网页界面迭代暂不编译 Android。最新网页计划已精简为一周、两周、一月或自定义，默认下次记录为上次拍照后一周，18:00；2026-09-22 按用户明确要求打包 Android 1.1.3，包含上述最新改动。

> 2026-09-21 当前产品更新：统一为用户，关闭家庭共享服务；首次建档只填名称与出生年份，拍摄固定正面 → 左侧 → 右侧。拍摄界面合并为正面、侧面两步，侧面按左→右连续采集；时间线取消学期选项。网页及 Android 1.1.2 已更新。见 [实施说明](docs/PERSONAL-MODE-2026-09-21.md) 与 [Android 安装说明](docs/ANDROID.md)。下方早期功能清单保留作历史参考。

> 2026-09-14 自动扶正：正面上传增加“估计倾斜→候选旋转→完整复检→采用或保留原图”，支持扶正前后对照。左右侧面因水平参照未验证暂不自动旋转；不处理三维姿态与透视。见 [自动扶正说明](docs/AUTO-STRAIGHTENING-2026-09-14.md)。

> 2026-09-13 左右侧面支持：侧面槽现在接受左侧或右侧90°照片，自动识别方向，沿用对应方向的模型裁切、几何与原图叠加。两侧使用相同质量和姿态门。见 [双向侧面验证](docs/BILATERAL-PROFILE-2026-09-13.md)。

> 2026-09-13 正确性修订：修复双眼倾斜符号与YuNet补边归一化；当前报告暂停脸型类别、二维对称残差、未验证参考带和相对头位的下颌倾斜读数。侧面旧“面凸角”改为“侧面三点内角”，不判定凸凹。下方历史研究清单不等于当前开放能力。执行结果及剩余验证见 [本轮实施记录](docs/CORRECTNESS-IMPLEMENTATION-2026-09-13.md)。

基于《颅面外观与骨性倾向分析 APP_V1 开发需求与技术方案》实现的商用试运营前端。产品定位是“照片驱动的可见外观结构测量与趋势记录”，不是医学诊断工具。

## 已实现

- 响应式品牌首页与 PWA 安装能力
- 成人结构模式 / 青少年趋势模式
- 三视角采集：正面、90° 侧面、头顶俯视
- 浏览器端真实图像质量基线：分辨率、亮度、对比度、清晰度
- 本地正面人脸检测与宽角度头部姿态门禁；正面额外限制 `|pitch| ≤ 9°`，经AFLW2000、Pointing'04与MUCT独立证据确认后降低误拒并控制镜头高低漂移
- 按原图宽高比校正的 12 项正面图像平面测量；按真人多机位/多光照证据标注较稳定、中等或拍摄敏感
- 独立 YuNet 人脸/多脸/取景门禁，正面与 90° 侧面均采用多模型一致性
- 正面明显眼部/口鼻遮挡门禁（不等同于活体或防翻拍）
- 上传前用途说明与非诊断确认
- 设备侧处理状态、免费摘要、指标置信度、示例付费墙
- 报告打印 / PDF 导出入口
- “不可判断项”、算法 / 参考 / 文案版本绑定
- 本地数据清除与隐私中心
- 离线缓存、移动端适配、键盘焦点与减少动画支持

## 本地运行

要求 Node.js 20.19+ 或 22.12+，并使用 pnpm。

```bash
pnpm install
pnpm dev
```

生产验证：

```bash
pnpm test
pnpm build
pnpm preview
```

## 商用边界

当前仓库交付的是可部署的研究验证前端、本地质量分析和初版姿态门禁。示例报告使用明确标记的校准示例；真人报告只显示当前照片计算出的 12 项正面候选，并公开稳定性等级。真实发布前必须接入并验证：

1. 专用侧貌关键点模型、头顶轮廓模型与 Web Worker。
2. 标准化重拍数据校准后的参考区间与 `tau` 参数。
3. 独立后端的账户、订单、动态同意、报告和删除 API。
4. 合规支付渠道、签名回调与服务端订单验签。
5. PDF 生成服务、对象存储生命周期和第三方删除闭环。
6. 医学顾问文案审核、亚组公平性测试与隐私影响评估。

任何“骨性分类、疾病、发育异常、治疗建议”能力都不属于 V1，可见外观倾向不得改名为诊断结论。

## 本地研究人像库

`data/face-db/` 是合成工程图像库；`data/face-db-real-research/` 是与其隔离的临时真实人像研究库。真实图像与 SQLite 文件只保存在本机并由 Git 忽略。

构建或刷新研究库：

```bash
pnpm data:real:import
pnpm data:real:classify
pnpm data:real:index
pnpm data:real:audit
pnpm test:real-faces
pnpm test:avatar-smoke
pnpm test:quality-calibration
pnpm test:wide-head-pose
pnpm test:yunet-head
pnpm test:omz-profile-landmarks
pnpm test:omz-profile-landmarks98
pnpm test:menpo-profile-groundtruth
pnpm test:spiga-menpo-profile-groundtruth
pnpm test:spiga-menpo-profile-semantic-calibration
pnpm test:spiga-merlrav-menpo-profile-groundtruth
pnpm research:train-menpo39-profile
pnpm test:menpo39-profile-geometry
pnpm research:finetune-menpo39-profile-geometry
pnpm test:menpo39-profile-calibration
pnpm research:train-menpo39-local-refiners
pnpm research:train-menpo39-pretrained-local-refiners
pnpm research:train-menpo39-multiscale-local-refiners
pnpm research:train-menpo39-normalized-multiscale-refiners
pnpm research:train-menpo39-joint-geometry-refiner
pnpm research:train-menpo39-specialist-geometry-refiners
pnpm research:train-menpo39-asymmetric-specialist-refiners
pnpm research:train-menpo39-hybrid-context-projection-refiners
pnpm research:train-menpo39-owned-context-projection-refiners
pnpm research:train-menpo39-split-control-refiners
pnpm test:menpo-front-groundtruth
pnpm test:wflw-front-groundtruth
pnpm test:wflw-contour-calibration
pnpm test:wflw-groundtruth-scales
pnpm test:front-repeatability:run
```

`pnpm test:avatar-smoke` 会从 NASA Image and Video Library 获取6张新的高分辨率单人官方肖像，记录逐图来源与使用指南后运行生产图片质量门，并生成本地分析页与截图。该命令只验证下载、来源记录、解码和图片质量，不把正面图复制为侧貌，也不验证关键点或骨性倾向。Wikimedia Commons许可源可用 `pnpm test:avatar-smoke:commons` 单独重试；128px拒绝基线为 `pnpm test:avatar-smoke:lowres-baseline`。

`pnpm test:avatar-full` 会从FFHQ公开1024px预览中确定性抽取60张真实对齐人脸，运行输入预检、质量、单人脸/取景、三轴姿态、478关键点、遮挡与12项正面测量。报告只展示18张代表性通过/失败图；运行成功后删除全部下载原图。若运行中断，应执行 `pnpm data:avatar:cleanup`，它会验证头像测试目录内不再残留JPEG/PNG/WebP。该流程验证生产管线行为和输入筛选，不提供几何测量真值。

`pnpm test:avatar-robustness` 会自动筛选同一60张中的生产合格基线，并对每张在内存生成JPEG75、亮度85%/115%、旋转±2°、右移/下移3%和中心放大5%共8类变体，再重跑整个生产管线。首次运行发现3%位移的黑边令低清放大检测误报，导致总体保留率仅75%；周期检测改为忽略外围5%后当时升至152/168（90.48%）。唇高微扰集成和中心高光规则接入后的当前冻结重跑为150/168（89.29%），8类各自仍≥80%、12/12测量门PASS；减少2张来自115%亮度新增的合理过曝拒绝。

唇高项另在同一168变体上审计12个保持外唇语义的候选：0–17面轴投影、三组/五组外唇距离的均值或中位数、三点/五点上下唇质心距离及其面轴投影。所有候选相对当前公式的尺度中位保持在0.948–1.020，但最好方案最差P95仍为8.77%，没有达到8%门；因此候选全部淘汰，生产公式未修改。下一步不得在同一来源继续调点，应使用微扰集成或新的独立人工唇点来源确认。

随后微扰集成候选在FFHQ发现：外唇37–84、0–17、267–314三组高度取中位，再对原图/上移1%/下移1%三次MediaPipe定位取中位，最差P95 3.91%、尺度中位1.024。固定候选在独立London 95张生产基线×8变体确认，P95 4.292%、尺度中位1.052，2/2门通过后才接入生产。接入后FFHQ稳健性总合同转为PASS，12/12几何门通过；中心高光规则后的当前20张性能见下方冻结值。该唇高值仍无人工解剖真值并保持`capture_sensitive`。

相机边界扩展又加入对比度85%、饱和度70%、暖色15%、0.6px模糊、横纵2%压缩和水平/垂直2%剪切，使测试增至16类、336变体。中心高光规则接入后重新下载60张并重跑：质量55/60通过，完整基线仍为21张；推荐8类150/168保留（89.29%）且12/12测量门PASS，扩展16类306/336（91.07%）。相比旧结果少2张来自115%亮度中新增的高光过曝拒绝，每类仍≥80%。扩展唯一失败仍是眼角倾斜代理在2%剪切下最差P95 1.099°，略超1°门；剪切会实际改变图像角度，因此扩展合同保持FAIL，并继续要求后置2×、眼平和避免广角透视。

`pnpm test:avatar-camera-stress:gate`会对同一聚合结果分别计算推荐8类合同和扩展16类合同：当前推荐合同PASS，扩展合同仅`eyeCanthalTiltDegrees`失败；评估器不重新下载图片或改动生产算法。

默认不保留原图的自动下载覆盖测试；AFLW2000命令按开发者要求例外保留50张匿名本地三轴姿态手测图：

```bash
pnpm test:transient-faces
pnpm test:stirling-real-sample
pnpm test:fei-multipose
pnpm test:aflw2000-yaw-groundtruth
pnpm test:transient-wide-pose
pnpm test:coco-nonperson-yunet
pnpm test:openimages-head-proxy
pnpm test:muct:prepare
pnpm test:muct:run
pnpm test:muct:cleanup
pnpm test:fairface:prepare
pnpm test:fairface:cleanup
pnpm test:physical-replay:prepare
pnpm test:physical-replay:cleanup
pnpm test:real-occlusion:prepare
pnpm test:real-occlusion:cleanup
pnpm test:aizoo-mask:prepare
pnpm test:aizoo-mask:run
pnpm test:aizoo-mask:cleanup
pnpm test:cmu-sunglasses:prepare
pnpm test:cmu-sunglasses:cleanup
pnpm test:openimages-sunglasses:probe
pnpm test:openimages-sunglasses:prepare
pnpm test:openimages-sunglasses:run
pnpm test:openimages-sunglasses:cleanup
pnpm test:openimages-glasses:probe
pnpm test:openimages-glasses:prepare
pnpm test:openimages-glasses:run
pnpm test:openimages-glasses:cleanup
pnpm test:oiv7-sunglasses-detector:prepare
pnpm test:oiv7-sunglasses-detector:run
pnpm test:oiv7s-sunglasses-detector:run
pnpm test:oiv7-sunglasses-detectors:glasses-control
pnpm test:oiv7-sunglasses-detector:cleanup
pnpm test:celeba-expression:prepare
pnpm test:celeba-expression:run
pnpm test:celeba-expression:cleanup
pnpm test:cew-eye-closure:prepare
pnpm test:cew-eye-closure:run
pnpm test:cew-eye-closure:cleanup
pnpm test:cew-eye-closure-highres:prepare
pnpm test:cew-eye-closure-highres:run
pnpm test:cew-eye-closure-highres:cleanup
pnpm test:openvino-eye-state:prepare
pnpm test:openvino-eye-state:run
pnpm test:openvino-eye-state:cleanup
pnpm test:anti-spoof-mn3:prepare
pnpm test:anti-spoof-mn3:run
pnpm test:anti-spoof-mn3:cleanup
pnpm test:silent-face-pad:prepare
pnpm test:silent-face-pad:run
pnpm test:silent-face-pad:cleanup
pnpm test:active-challenge:prepare
pnpm test:active-challenge:run
pnpm test:active-challenge:cleanup
pnpm test:active-challenge:fake-camera
pnpm test:angle-challenge:prepare
pnpm test:angle-challenge:run
pnpm test:angle-challenge:cleanup
pnpm test:nuaa-print:prepare
pnpm test:nuaa-print:run
pnpm test:nuaa-print:cleanup
```

另有浏览器研究页用于同图测量扰动、侧面关键点、MUCT 多相机人工点、FairFace 分层覆盖、遮挡/翻拍代理和真实物理屏幕重放回归；其结果分别保存在 `data/face-db-real-research/` 与 `data/face-benchmark/` 的聚合 JSON 中。历史眼镜/墨镜实验仅作为既有风险记录保留，不再是当前算法研发主线；产品协议要求拍摄时摘下所有眼镜。瞬态流程确保源包、临时运行时、抽取图和视频在结果固化后删除，并只保留汇总指标。Pointing Hair Segmenter 基准默认使用 Python 3.11，并把 LiteRT、NumPy 与 Pillow安装到随测试删除的隔离目录；也可通过 `HEADUP_PYTHON` 指定兼容解释器。模型来源、哈希和已知能力边界见 `docs/MODEL-ASSETS.md`。

`/research-local-occlusion.html` 提供产品分辨率的本地真人配对复测：同一设备依次采集无遮挡、真实口罩、真实墨镜各 3 张。照片只进入内存中的生产门禁；页面不会上传或写入浏览器存储，导出的匿名 JSON 只保留设备类别、光线类别、分辨率、通过/阻断计数和原因汇总，不含图片、文件名、哈希、关键点或人口属性。

`/research-local-retake.html` 提供标准手机真人跨时段重拍：同一测试者在相隔至少 24 小时的 A/B 时段，各完成 3 次离开画面后重新站位、对准和对焦的正面拍摄。照片不上传、不预览、不写入浏览器存储；A/B 临时 JSON 只为误差计算暂存随机令牌和 12 项几何值，不含图片、文件名、哈希、关键点或人口属性。两个时段汇总后应立即删除临时文件。

`pnpm research:prepare-manual-regression`从现有102人/306张本地授权库确定性生成58条审核清单，不复制图片：30张正面保留3张人工确认的明亮阈值边界和27张质量分跨度对照，左右侧各10张覆盖质量范围；另引用8张原图及内存变换规则，覆盖低照度、过曝、模糊提示和模糊阻断阈值。启动开发服务后打开`/manual-regression-review.html`，可逐图选择PASS/FAIL/需复核、问题类型和备注，并按需运行当前生产门。“人工缺陷”筛选读取正式缺陷清单，标出当前行为已改变但仍需人工确认的案例；导入旧审核JSON只恢复人工决策，自动详情始终优先使用当前生产分析，避免旧阈值快照覆盖新结果。页面状态只在内存，匿名导出JSON不含图片、路径、哈希或人口属性。

`pnpm test:quality-boundary`用102张真实正面图生成15级亮度/模糊内存矩阵，共1,530次质量门。人工审核认为3张平均亮度206.64–209.39的原图可接受后，生产过曝均值阈值从205最小放宽到210；跨背景中心高光信号接入后，当前9/9门通过，130%/150%/180%/200%过曝均102/102命中，25%低照度和4px模糊仍102/102给出目标阻断原因。8个阈值附近案例自动进入手工审核页，但变体不写盘。

`pnpm test:exposure-external`会复用FFHQ-Aging瞬态下载流程，在10年龄组×2标签×每格10张的200张独立来源上生成原始JPEG、130%和200%亮度共600个输入。首轮预声明合同FAIL：原图198/200接受，但全图平均亮度规则对130%/200%只明确命中过曝4/200与46/200，证明London白背景上的高命中不能外推到多背景来源。该失败结果保留为否定证据，图片、标签、267MB元数据、路径、哈希和逐图输出均在结束后删除。

随后`pnpm test:exposure-highlight-calibration`在每个覆盖单元固定前5张工程、后5张留出，比较60个中心高光指标/阈值候选。冻结候选为中心椭圆内“至少两个RGB通道≥250”的像素占比≥6%；工程原图误报0/100、200%命中96/100，隔离留出原图误报4/100、200%命中97/100，20个单元和生产接入11/11门全部通过。`pnpm test:exposure-highlight:london`再确认London 306原图候选误报0、三张人工明亮边界全部低于0.31%、102张200%强过曝102/102命中。生产现在保留平均亮度>210规则，并增加中心高光裁切信号；London亮度梯度130%–200%均102/102命中过曝。全部网络图片继续瞬态清理。

`pnpm test:exposure-fairface`进一步从官方校验Parquet确定性抽取840张224px紧裁剪图，覆盖7个肤色/族群标签×2个性别呈现×4年龄桶×每格15张。分辨率不满足生产门，因此只审计高光标志：原图误报9/840且原图标签组差仅2.5个百分点，但200%乘法只命中593/840，不同标签组命中率57%–81%，差24.16个百分点，预声明合同FAIL。该结果说明相同亮度倍率不等于相同真实曝光损失，不能据此继续调低阈值。下一真值源锁定PIQ23：官方提供5116张真实手机人像、100多款设备、50场景和30多位专家的face-target-exposure成对标注，但5GB图片需填写表单取得临时链接；未取得前保持为发布风险。FairFace源包、PyArrow运行时、840张图片和清单已删除。

`pnpm test:exposure-position`检查固定中心椭圆是否会因取景偏移漏检：102张London正面以1.2×无黑边取景，在中心、左右和上下10%五位置分别生成原图与200%强过曝，共1,020次生产质量测试。五位置原图均102/102接受且0过曝误报，强过曝均102/102命中且0接受，位置差0，6/6门通过。该合同只覆盖产品允许范围内的平移，不外推到脸部靠近画面边缘的无效取景。

`pnpm test:exposure-encoding`对20张等距London正面生成原图/200%强过曝×1080/720/512×PNG/JPEG95/JPEG75/WebP90，共480个内存输入。原图240个组合0过曝，强过曝240/240命中；逐图跨编码和尺寸标志完全一致。高光比例的编码P95漂移为原图0.000496、强过曝0.014736，分别低于0.01/0.03门，7/7通过。512输入仍会由分辨率门独立拒绝，本合同只验证高光信号不会因缩放或编码消失。

`pnpm test:exposure-exif`为20张真人分别生成原图/200%×EXIF方向1/3/6/8共160张临时JPEG。Chromium自动方向纠正后，四方向显示尺寸均40/40正确，原图均0/20过曝、强过曝均20/20命中，逐组标志与方向1完全一致；中心裁切比例P95漂移0.001861，低于0.005门，6/6通过。套件在`finally`删除全部160张方向变体。

`pnpm test:exposure-icc`为20张真人分别生成原图/200%×sRGB基线4:4:4、无ICC sRGB、Display-P3 4:4:4、渐进sRGB 4:2:0、渐进P3 4:2:0共200张临时JPEG。五编码原图均0/20过曝、强过曝均20/20命中，标志逐图与sRGB基线一致；最大高光比例P95漂移0.002688，低于0.02门，6/6通过。该结果只覆盖Chromium SDR色彩管理，不外推到HDR或厂商私有ICC。

`pnpm test:exposure-avif`为20张真人分别生成原图/200%×JPEG95/AVIF90共80个输入。JPEG与AVIF原图均0/20过曝、强过曝均20/20命中，40组标志完全一致；高光比例P95差0.000712，低于0.02门，5/5通过。该结果覆盖Chromium中的SDR AVIF90，不外推到HDR AVIF、手机厂商编码器或HEIC。

`pnpm test:lowlight-fairface`在同一840张FairFace分层样本上只审计“光线不足”标志：25%极暗变体840/840命中，标签组命中差0；但无专家曝光标签的原图有70/840被标低光，高于预声明42张门，最差标签组原图率13%、最低5%，差8.33个百分点，整体6/9门FAIL。由于这些在野原图可能确实低光，70张不能直接称为误报，也不能用于放宽60阈值；结果与过曝FairFace FAIL共同指向PIQ23专家face-target-exposure真值。源包、运行时、840张图和清单已删除。

`pnpm test:manual-package:auto`会在真实Chromium中预跑58条审核输入并写入匿名`auto-analysis.json`，页面下次加载时自动展示逐例质量、姿态、478点和测量摘要，但不会填写人工PASS/FAIL。阈值调整后58/58无分析错误；30张正面质量30/30通过、姿态29/30通过，29张生成12项，三张人工明亮边界均由拒绝转为完整测量；左侧10张全部拒绝（9张方向相反、1张横倾优先），右侧10张全部通过；8条质量边界中2张提示级输入生成测量、6张阻断输入不出测量。

`pnpm test:manual-package:triage`比较浏览器权威清单与当前Chromium结果并生成`defect-candidates.json`。当前关键和建议合同全部通过：接受/拒绝58/58一致、拒绝图0测量、可用正面均12项、右侧10/10通过、左侧10/10拒绝；“差异优先”只剩1张左侧横倾原因优先诊断，不是自动确认缺陷。

质量发布门以Chromium为唯一权威：过曝阈值调整后306张同图比较中Node/Sharp通过305张、浏览器306张，存在1张阻断差异和14张标志差异；分数P95差13，来源几乎全是缩放后清晰度分项P95差42。nearest/cubic/mitchell/lanczos2/lanczos3五种Sharp核均无法达到精确奇偶性，因此`pnpm test:real-faces:gate`会先重新生成Node基线，再运行真实Chromium并生成10门报告，避免读取过期缓存；旧Node门仅保留为`test:real-faces:gate:node`离线诊断。当前浏览器结果306/306、10/10门PASS，Node只作辅助。

`pnpm report:release-readiness`会实际运行单测和生产构建，再读取浏览器门、推荐相机合同、性能、AVIF、人口覆盖、需求矩阵和执行清单，生成`docs/RELEASE-READINESS.md`与`data/release-readiness.json`。当前正面研究演示为`READY_WITH_MANUAL_VALIDATION_PENDING`，商用V1为`NOT_READY`，医学用途`OUT_OF_SCOPE`；不得用自动门数量覆盖手机复拍、侧貌/顶部真值、人口采集差异和后端支付/删除缺口。

人工审核页支持匿名JSON导出与导入恢复，不使用localStorage。导入会拒绝版本/清单不匹配、未知或重复review ID、非法决策/问题类型、超过500字备注，以及任意层级的路径、图片哈希或人口属性字段；文件上限2MB。浏览器实测可恢复2/58决策，刷新后仍归零，测试夹具随后删除。

人工审核完成或阶段性导出后运行`pnpm test:manual-review:gate -- <review.json>`：分别检查正面30、侧脸20、质量边界8是否全部有决策，FAIL/需复核是否选择问题类型，并生成匿名`manual-review-gate.json`和`manual-review-defects.json`。当前正式结果58/58覆盖完成、55 PASS、3 FAIL；三项均为已完成算法修复的明亮边界，需在新阈值下人工复核后才能关闭。覆盖完成与发布通过严格分离：存在任何FAIL/需复核时，人工发布门仍为FAIL。`--dry-run`只检查不写正式结果。

`pnpm test:top-contour:tvheads`会匿名下载TVHeads v1（76,990,092 bytes，固定SHA-256），验证1815组16位深度/8位深度/人工mask三元组并按采集会话隔离。数据覆盖9会话、297空场景、611单头、907多头和586贴边帧。简单绝对深度阈值在342帧未见会话留出Dice中位0.365/P95 0.454，判定不足且不接入生产。流程确定性保留24组8位深度＋mask作为手测包，删除完整1815组、16位深度、ZIP和TAR。打开`/manual-top-contour-review.html`可筛选空/单/多头与贴边、查看红色mask叠加、运行当前HeadUp顶视门并导出匿名结论。

后脑RGB另从Roboflow Universe公开`back head` v1页面获取3张公开原图并裁成头部中心手测图，覆盖短发斜后方、双人远距和长发遮挡。完整994张匿名导出受登录/Cloudflare限制；RenderMe-360与Gaze360需要协议/机构申请。打开`/manual-back-head-review.html`可运行当前顶视占位门；三张当前均0完整面部检测并进入review，但没有后脑轮廓输出。详细边界见`docs/HEAD-TOP-BACK-DATA-CARD.md`。

`/research-progress.html` 汇总开发者当前完成度、真人图片分析流程、AFLW2000三轴结果、V13否定验证以及MERL/3DDFA/Menpo39三方menton留一法坐标合同；配套实际页面截图与详细解释见 `docs/DEVELOPER-TEST-REPORT.md`，V14冻结要求见`docs/MENTON-V14-TRAINING-CONTRACT.md`。页面只显示聚合证据，不显示测试人像；V13权重已删除，V14在新人工canonical truth完成前禁训。

`/research-menton-annotation.html`提供V14本地A/B独立盲标、一致性聚合和第三方盲裁决。页面不显示任何旧模型/数据集候选点，不上传或存图；会话JSON不含文件名，聚合报告不含哈希和逐图坐标。A/B分歧超过2%时由第三人盲标，canonical点取三个人工点几何medoid。

标注流程试运行可依次执行`pnpm research:prepare-menton-annotation-pilot`、`pnpm research:status-menton-annotation-pilot`和`pnpm research:cleanup-menton-annotation-pilot`。它会从固定FEI官方包自动选择60人×左右2张匿名临时批次；仅用于A/B工具验收，`trainingUseAllowed=false`。完成或取消后必须运行cleanup，聚合结果记录逐哈希清理证明。

原始DOCX需求逐项状态见`docs/REQUIREMENTS-COVERAGE-AUDIT.md`。FR-201现对真人正面报告提供478点、15条测量线和12组镜像对的独立开关；12项测量卡可展开公式、MediaPipe点索引与置信度来源。只有真实正面关键点存在时才显示覆盖，示例页不会伪造真人478点。

FR-105表情V2补搜旧网格遗漏的`jawOpen 0.01–0.14`区间，并以100/100身份隔离FEI正面中性代理约束误拒；结果仍仅3/8门，生产保持禁用。聚合见`data/face-benchmark/celeba-expression-v2-result.json`，全部828张瞬态输入已删除。

质量门已增加低清放大检测：周期梯度峰值阈值固定为1.19081898，最近邻放大从44/50绕过降至集成留出0/25，五种放大变体均0放行，London清晰留出新增误拒0/17；Chromium内存合成4/4奇偶性门通过。它不覆盖神经超分或生成式恢复；聚合见`quality-upscale-attack-result.json`、V3与浏览器奇偶性结果。

冻结阈值又通过FEI新来源外部确认：50身份×双侧×五变体共500张全部0放行，London新右侧清晰控制102/102放行且0低清标志；聚合见`quality-upscale-external-result.json`。所有外部图片和生成攻击均已删除。

官方ONNX子像素CNN神经超分50张同样0放行，但只有45/50被明确归因为低清放大，其余由模糊/光线门阻断；4/5门。接受阻断有效，解释归因仍未达到95%，不能外推到现代人脸修复或生成式超分。

EXIF方向1/3/6/8已在Chromium用20组80张真实正面图验证：显示尺寸、质量放行和姿态状态全部一致，三轴P95差0.2°、478点RMS P95 0.05%，8/8门通过。Safari/iOS/Android仍需设备矩阵复核。

所有图像解码入口现先运行`imageInputPreflight.ts`：验证JPEG/PNG/WebP/AVIF真实魔数、受限BMFF结构与尺寸，限制30MB、8000万像素和20000单边，并缓存同一File的预检Promise；伪装、损坏及超大声明尺寸在`createImageBitmap`前拒绝。HEIC/HEIF会在解码前提示从手机相册导出为兼容格式。

主采集通过`captureAnalysis.ts`让质量、MediaPipe、WHENet和YuNet共享一个只读`ImageBitmap`并统一关闭；EXIF真人基准80张恰好80次解码、9/9门通过。移动设备≤5秒与Web Worker仍待设备矩阵验证。

中心高光规则接入并优化椭圆遍历后，桌面Chromium20张完整管线当前冻结性能为冷启动1.293秒、暖机中位377.8ms/P95 395.3ms，Long Task P95/最大250ms，7/7门通过；20张恰好20次解码，19张输出478点。历史运行更快，说明桌面测量存在环境波动；Long Task已到预声明上限，必须在iOS/Android实机继续验证≤5秒、峰值内存、热态和交互阻塞。

正面12项另通过横/竖黑白留白10%、最大边512缩放和JPEG50共120变体逐项门；纵向留白的唇高嘴宽比P95约7.8%，仍按拍摄敏感处理。聚合见`front-canvas-perturbation-result.json`。

JPEG/PNG/WebP在20张真人、60个格式比较中保持尺寸、质量放行、姿态和478点一致；WebP90质量分P95差4分导致总门7/8。三格式继续支持，但质量分不用于跨编码纵向比较。

手机相册常见色彩编码另以20张真人生成sRGB ICC、无ICC、Display-P3 ICC、渐进式sRGB/P3和4:2:0/4:4:4共100张变体。Chromium中80组比较的渲染RGB、质量放行、姿态和478点10/10门通过；生产保留这些JPEG编码支持。结论不外推到Safari/iOS/Android、HDR/HEIC或厂商私有ICC。

AVIF以20组JPEG95/AVIF90真人在Chromium确认9/9门：质量与姿态20/20一致，三轴P95最大0.4°、478点RMS P95 0.049%，暖机完整分析P95 254ms。文件选择已开放`image/avif`；HEIC仍不支持解码。

镜像自拍不能直接视为等价输入：London 102人原始镜像只通过3/7门，姿态轴和7项几何超过预声明P95门。正面上传卡新增用户显式镜像纠正；勾选后本地复原为无损PNG再进入同一管线，同一102人纠正验证7/7门通过、12项差P95均为0。侧貌不提供该选项，产品也不自动猜测镜像状态。

年龄/性别覆盖新增FFHQ-Aging瞬态审计：10个年龄段×2种标签×每格10张，共200张1024px真人图。MediaPipe与YuNet均检出194/200，年龄/性别检测差10/2个百分点；质量放行198/200，但正面姿态只124/200、年龄放行差30个百分点，因此只保留检测覆盖结论，不宣称拍摄体验或测量公平性。官方元数据、标签、200张图、匿名映射和逐图结果均在运行后删除，仅保留`demographic-coverage-result.json`聚合。

`/research-active-challenge.html` 提供本地前置摄像头随机转头研究：随机要求左右先后，连续检查“正面—一侧—正面—另一侧—正面”的单人脸、取景、偏航、横倾和时序。摄像头帧不上传、不录像、不写入浏览器存储。102 名真实受试者三视角序列代理通过 186/204；6 段普通屏幕翻拍形成的 164 个连续攻击窗口误受 0 次。但 Pointing'04 的真实多角度帧按指令平滑注入时通过 22/30；进一步把 5 名授权真人的三视角图编成 640×480、10 fps 的临时 Y4M 并经 Chromium 虚拟摄像头送入完整 `getUserMedia` 前端链路，15 次中有 11 次被接受，两种随机顺序都被攻破。18 种角度候选仍误受 64/270 平滑注入且动作代理完成率同样只有 64/270，因此未接入。该页不是认证活体/PAD，也不验证摄像头来源。

CelebA 真实表情候选审计同样采用 `prepare → 浏览器基准页 → cleanup`：628 张下载图仅在瞬态目录用于非商用研究，按身份隔离校准/留出，结束后删除图片、身份映射和逐图输出，只保留聚合 JSON。当前召回和覆盖不足，候选阈值未接入生产。

CEW 真实闭眼审计提供 2,423 个独立身份的闭眼/睁眼完整面部，并分别测试 100×100 统一变形版和较高分辨率复核版；两轮都按身份隔离工程/留出集并加测 102 张授权睁眼对照。较高分辨率留出闭眼召回仍只有 79.00%，阈值未接入生产。RAR/TGZ、含姓名目录、匿名图和逐图结果均由 cleanup 删除。

Open Model Zoo 专用睁闭眼 ONNX 也可用三段式流程在同一 CEW/LFW 留出集上复核。它的留出闭眼召回/睁眼误拒为 47.33%/2.47%，显著差于同图 MediaPipe 的 79.00%/1.29%，因此模型只保留聚合否定证据，权重已删除。

Open Model Zoo `anti-spoof-mn3` 可用三段式流程审计商用许可方向兼容的静态 RGB PAD 候选。阈值用 85 名授权真人和 3 段翻拍视频选择，17 名真人与另外 3 段视频留出；留出中真人误拒 0/17，但只抓住 5/14 个生产门禁放行攻击帧，最终仍放行 9/18 个攻击帧，因此不接入生产。ONNX、328.6 MB 视频和逐帧预测已删除。

NUAA 真实打印照片扩展从官方 5,105 真人/7,509 攻击中分层抽取 1,920 张，使用同一冻结 `anti-spoof-mn3` 管线。阈值 0.78 在第三会话真人误拒 4/600，仍放过 77/600 张打印照片；约束工程真人误拒不超过 1% 的源内阈值则放过 170/600。该结果不能挽救已否定候选；74.7 MB 源包、图片、映射和模型均已删除。

MIT 许可的 AIZOO FaceMaskDetection 专用模型也按三段式完成全量审计：阈值只使用 300 个 CEW 无口罩工程身份与 85 名授权无遮挡工程真人选择；全部 1,194 张 RMFD 真实口罩图、23 个身份均作为外部阳性评估，不参与阈值选择。满足工程无遮挡误拒不超过 1% 时，真实口罩只抓住 1,075/1,194（90.03%），低于 95% 门槛；CEW 留出误拒 8/931，授权高清真人留出误拒 0/17。模型不接入生产；模型、2,425 张下载图、临时 OpenCV 运行时和逐图结果均已删除。

Apache-2.0 的 Minivision Silent-Face 双尺度 MiniFASNet 也采用相同三段式、身份/视频隔离复核。留出真人误拒 0/17，但只抓住 7/14 个生产门禁放行攻击帧，最终仍放行 7/18；因此同样不接入生产。约 3GB 临时 Torch CPU 运行时、源码、权重、视频和逐项分数已删除。

多个本地会话可离线合并；输出路径采用仅新建模式，避免覆盖已有研究结果：

```bash
pnpm research:occlusion:aggregate --out local-occlusion-aggregate.json session-1.json session-2.json
```

汇总器会拒绝不完整协议、重复匿名会话编号、未知设备/光线类别及不符合零图片留存边界的输入。阻断率只使用无遮挡基线先通过的配对作为分母；跨会话输出不会保留输入路径或会话编号。

真人重拍 A/B 会话使用单独的严格汇总器；它会排除设备/光线不一致、B 距 A 不足 24 小时或任一时段少于 2 次可用测量的配对，输出不含配对令牌、时间戳和逐次测量：

```bash
pnpm research:retake:aggregate --out local-retake-aggregate.json participant-01-A.json participant-01-B.json
```

少于 30 个合格配对的结果会自动标记为工程诊断，不能形成总体准确率或发布声明。完成汇总并核对输出后，删除全部 A/B 临时会话 JSON，只保留聚合结果。

导入流程排除了来源中的人口统计信息和吸引力评分，只保留中性表情的正面、左侧面和右侧面图像；工程集/留出集按假名化受试者编号分组。授权、保留期及禁止用途见 `data/face-db-real-research/DATA_CARD.md`。

到期清理本地图片、清单和 SQLite：

```bash
pnpm data:real:purge -- --confirm
```

## 目录

- `src/App.tsx`：产品状态机与全部可见流程
- `src/lib/imageQuality.ts`：设备侧图像质量评分
- `src/lib/facePose.ts`：MediaPipe、WHENet 与 YuNet 的设备侧并行编排
- `src/lib/faceDetector.ts`：YuNet 等比例预处理、解码和 NMS
- `src/lib/poseRules.ts`：可单元测试的视角方向与门禁规则
- `src/lib/frontOcclusion.ts`：明显眼部/口鼻遮挡代理门禁
- `src/data/report.ts`：报告字段、边界项与版本绑定
- `docs/API-CONTRACT.md`：生产服务接口契约
- `public/favicon.svg`：PWA 图标

## 隐私与安全默认值

- 无远程 API 配置时不发出照片请求。
- 不接入第三方字体、分析 SDK 或广告脚本。
- 原图预览使用对象 URL，仅存在于页面内存。
- 远程报告必须通过独立、非预勾选同意开关启用。
- 支付密钥、对象存储密钥和模型服务凭证只能存在于服务端。
