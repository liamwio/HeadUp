import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { createProductionQualityHarness } from "./lib/headup-quality-harness.mjs";

setDefaultResultOrder("ipv4first");
const execFileAsync = promisify(execFile);

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const dataRoot = join(projectDir, "data", "face-db-real-research", "avatar-smoke");
const POLICY_VERSION = "HEADUP-REAL-RESEARCH-1.1";
const USER_AGENT = "HeadUp research QA/1.1 (local non-commercial quality regression)";
const COMMONS_TITLES = [
  "File:Anna Gres 2015 (facecrop).jpg",
  "File:Annalise Morelli Headshot.jpg",
  "File:Hannah Altman.jpg",
  "File:Abraham Ruiz Jimenez.jpg",
  "File:Adam Ali fitness portrait.jpg",
  "File:Anders Fredricsson.jpg",
];
const NASA_IDS = [
  "jsc2025e068207_alt",
  "jsc2016e096719",
  "jsc2025e058846_alt",
  "jsc2023e047050_alt",
  "jsc2005e02663",
  "jsc2018e095073_alt",
];
const FFHQ_ROW_INDICES = Array.from({ length: 60 }, (_, index) => Math.round(index * 99 / 59));

const sourceName = process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1] || "commons";
const sourceConfigs = {
  nasa: {
    outputId: "nasa-highres",
    sourceId: "avatar-smoke-nasa-images-highres",
    sourceType: "official-informational-portrait",
    consentBasis: "NASA Images and Media Usage Guidelines; local educational/informational research QA only.",
    note: "输入来自NASA Image and Video Library官方真人肖像；逐图记录NASA ID和来源页",
  },
  ffhq: {
    outputId: "ffhq-highres",
    sourceId: "avatar-regression-ffhq-preview-highres",
    sourceType: "permissively-licensed-research-face-dataset",
    consentBasis: "FFHQ non-commercial research terms; individual source licenses are recorded in original FFHQ metadata.",
    note: "输入来自FFHQ公开1024px预览的确定性广覆盖抽样；不生成或保留人口属性推断",
  },
  commons: {
    outputId: "commons-highres",
    sourceId: "avatar-smoke-wikimedia-commons-highres",
    sourceType: "licensed-public-portrait",
    consentBasis: "Wikimedia Commons file-page license; local research QA only.",
    note: "输入来自Wikimedia Commons自由许可真人肖像；许可证和作者逐图记录",
  },
  randomuser: {
    outputId: "randomuser-lowres",
    sourceId: "avatar-smoke-randomuser-me-lowres-baseline",
    sourceType: "public-avatar-demo",
    consentBasis: "Research-only demo testing; images are public demo portrait photos.",
    note: "输入来自randomuser.me；仅作为128px低清拒绝基线",
  },
};
const sourceConfig = sourceConfigs[sourceName];
if (!sourceConfig) throw new Error(`未知头像源: ${sourceName}。可选: ${Object.keys(sourceConfigs).join(", ")}`);

const avatarRoot = join(dataRoot, sourceConfig.outputId);
const imageDir = join(avatarRoot, "images");
const manifestPath = join(avatarRoot, "manifest.jsonl");
const resultPath = join(avatarRoot, "avatar-smoke-headup-result.json");
const casePath = join(avatarRoot, "avatar-smoke-headup-cases.jsonl");
const htmlReportPath = join(projectDir, '.local-archive', 'reports', `avatar-smoke-${sourceConfig.outputId}-analysis.html`);

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stripHtml(value = "") {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))];
}

async function fetchWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
  }
  throw new Error(`网络请求失败（已重试${attempts}次）: ${url}`, { cause: lastError });
}

async function fetchJson(url) {
  if (process.platform === "win32") {
    const escapedUrl = url.replaceAll("'", "''");
    const command = `$r=Invoke-WebRequest -UseBasicParsing -Uri '${escapedUrl}' -Headers @{'User-Agent'='${USER_AGENT}'}; $r.Content`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(stdout.replace(/^\uFEFF/, ""));
  }
  try {
    const response = await fetchWithRetry(url);
    return response.json();
  } catch (error) {
    if (process.platform !== "win32") throw error;
    const escapedUrl = url.replaceAll("'", "''");
    const command = `$r=Invoke-WebRequest -UseBasicParsing -Uri '${escapedUrl}' -Headers @{'User-Agent'='${USER_AGENT}'}; $r.Content`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(stdout.replace(/^\uFEFF/, ""));
  }
}

async function downloadBytes(url, targetPath) {
  if (process.platform === "win32") {
    const escapedUrl = url.replaceAll("'", "''");
    const escapedPath = targetPath.replaceAll("'", "''");
    const command = `Invoke-WebRequest -UseBasicParsing -Uri '${escapedUrl}' -OutFile '${escapedPath}' -Headers @{'User-Agent'='${USER_AGENT}'}`;
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { maxBuffer: 4 * 1024 * 1024 });
    const bytes = await readFile(targetPath);
    const metadata = await sharp(bytes).metadata();
    if (!metadata.format) throw new Error(`下载内容不是可识别图片: ${url}`);
    return { bytes, mimeType: `image/${metadata.format === "jpg" ? "jpeg" : metadata.format}` };
  }
  try {
    const response = await fetchWithRetry(url);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) throw new Error(`非图片内容: ${url} -> ${contentType}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(targetPath, bytes);
    return { bytes, mimeType: contentType.split(";")[0] };
  } catch (error) {
    if (process.platform !== "win32") throw error;
    const escapedUrl = url.replaceAll("'", "''");
    const escapedPath = targetPath.replaceAll("'", "''");
    const command = `Invoke-WebRequest -UseBasicParsing -Uri '${escapedUrl}' -OutFile '${escapedPath}' -Headers @{'User-Agent'='${USER_AGENT}'}`;
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { maxBuffer: 4 * 1024 * 1024 });
    const bytes = await readFile(targetPath);
    const metadata = await sharp(bytes).metadata();
    if (!metadata.format) throw new Error(`下载内容不是可识别图片: ${url}`);
    return { bytes, mimeType: `image/${metadata.format === "jpg" ? "jpeg" : metadata.format}` };
  }
}

async function fetchCommonsPortraits() {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "1600",
    titles: COMMONS_TITLES.join("|"),
  });
  const payload = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`);
  const byTitle = new Map((payload.query?.pages || []).map((page) => [page.title, page]));
  return COMMONS_TITLES.map((title) => {
    const info = byTitle.get(title)?.imageinfo?.[0];
    const metadata = info?.extmetadata || {};
    if (!info?.thumburl || !info?.descriptionurl) throw new Error(`Commons文件不可用: ${title}`);
    const license = stripHtml(metadata.LicenseShortName?.value || "");
    if (!/^(CC BY|CC BY-SA|CC0|Public domain)/i.test(license)) {
      throw new Error(`Commons文件许可证不在允许列表: ${title} -> ${license || "missing"}`);
    }
    return {
      title,
      url: info.thumburl,
      sourcePageUrl: info.descriptionurl,
      originalUrl: info.url,
      originalWidth: info.width,
      originalHeight: info.height,
      license,
      licenseUrl: metadata.LicenseUrl?.value || null,
      artist: stripHtml(metadata.Artist?.value || metadata.Credit?.value || "未提供"),
      attributionRequired: metadata.AttributionRequired?.value || null,
    };
  });
}

async function fetchRandomUserPortraits() {
  const payload = await fetchJson("https://randomuser.me/api/?results=6&inc=picture");
  return payload.results.map((item, index) => ({
    title: `randomuser-${index + 1}`,
    url: item.picture?.large,
    sourcePageUrl: "https://randomuser.me/",
    originalUrl: item.picture?.large,
    license: "demo-api-unspecified",
    licenseUrl: null,
    artist: "randomuser.me",
    attributionRequired: null,
  })).filter((item) => item.url);
}

async function fetchNasaPortraits() {
  const portraits = [];
  for (const nasaId of NASA_IDS) {
    const search = await fetchJson(`https://images-api.nasa.gov/search?nasa_id=${encodeURIComponent(nasaId)}&media_type=image`);
    const item = search.collection?.items?.[0];
    const data = item?.data?.[0];
    const assets = await fetchJson(`https://images-api.nasa.gov/asset/${encodeURIComponent(nasaId)}`);
    const urls = (assets.collection?.items || []).map((entry) => entry.href).filter(Boolean);
    const imageUrl = urls.find((url) => /~large\.jpe?g$/i.test(url)) || urls.find((url) => /~orig\.jpe?g$/i.test(url));
    if (!data || !imageUrl) throw new Error(`NASA图片或元数据不可用: ${nasaId}`);
    portraits.push({
      title: data.title || nasaId,
      url: imageUrl.replace(/^http:/, "https:"),
      sourcePageUrl: `https://images.nasa.gov/details/${encodeURIComponent(nasaId)}`,
      originalUrl: imageUrl.replace(/^http:/, "https:").replace(/~large\.jpe?g$/i, "~orig.jpg"),
      license: "NASA Images and Media Usage Guidelines",
      licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
      artist: data.photographer || data.center || "NASA",
      attributionRequired: "NASA source acknowledgement",
      nasaId,
      description: data.description || null,
      dateCreated: data.date_created || null,
    });
  }
  return portraits;
}

async function fetchFfhqPortraits() {
  const apiUrl = 'https://datasets-server.huggingface.co/first-rows?dataset=marcosv%2Fffhq-dataset&config=default&split=train';
  const payload = await fetchJson(apiUrl);
  const rowMap = new Map((payload.rows || []).map((item) => [item.row_idx, item.row]));
  return FFHQ_ROW_INDICES.map((rowIndex) => {
    const row = rowMap.get(rowIndex);
    if (!row?.image?.src) throw new Error(`FFHQ预览缺少确定性样本: row ${rowIndex}`);
    return {
      title: `FFHQ preview row ${rowIndex}`,
      url: row.image.src,
      sourcePageUrl: 'https://huggingface.co/datasets/marcosv/ffhq-dataset',
      originalUrl: null,
      license: 'FFHQ: per-image permissive licenses; dataset CC BY-NC-SA 4.0',
      licenseUrl: 'https://github.com/NVlabs/ffhq-dataset#licenses',
      artist: 'See original FFHQ per-image metadata',
      attributionRequired: 'Refer to original FFHQ metadata before publication or redistribution',
      externalAssetId: `ffhq-preview-row-${String(rowIndex).padStart(3, '0')}`,
      description: 'Deterministic row from a 1024x1024 FFHQ dataset preview',
    };
  });
}

function subjectId(index) {
  return `${sourceConfig.outputId}-${String(index + 1).padStart(3, "0")}`;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

async function main() {
  await mkdir(imageDir, { recursive: true });
  const portraits = sourceName === "commons"
    ? await fetchCommonsPortraits()
    : sourceName === "nasa"
      ? await fetchNasaPortraits()
      : sourceName === "ffhq"
        ? await fetchFfhqPortraits()
        : await fetchRandomUserPortraits();
  if (!portraits.length) throw new Error("未拿到头像链接");
  const now = new Date().toISOString();
  const manifests = await mapWithConcurrency(portraits, 6, async (portrait, index) => {
    const profileId = subjectId(index);
    const outputName = `${profileId}_front.jpg`;
    const outputPath = join(imageDir, outputName);
    const { bytes, mimeType } = await downloadBytes(portrait.url, outputPath);
    const metadata = await sharp(outputPath).metadata();
    const fileStat = await stat(outputPath);
    return {
      id: `${profileId}-front`,
      pseudonymousSubjectId: profileId,
      relativePath: `data/face-db-real-research/avatar-smoke/${sourceConfig.outputId}/images/${outputName}`,
      sha256: sha256Buffer(bytes),
      bytes: fileStat.size,
      mimeType,
      width: metadata.width || null,
      height: metadata.height || null,
      sourceId: sourceConfig.sourceId,
      sourceType: sourceConfig.sourceType,
      sourceTitle: portrait.title,
      sourcePageUrl: portrait.sourcePageUrl,
      originalUrl: portrait.originalUrl,
      originalWidth: portrait.originalWidth || null,
      originalHeight: portrait.originalHeight || null,
      license: portrait.license,
      licenseUrl: portrait.licenseUrl,
      artist: portrait.artist,
      attributionRequired: portrait.attributionRequired,
      externalAssetId: portrait.externalAssetId || portrait.nasaId || null,
      sourceDescription: portrait.description || null,
      sourceDateCreated: portrait.dateCreated || null,
      subjectType: "real-avatar-research-sample",
      consentBasis: sourceConfig.consentBasis,
      view: "front",
      viewGroundTruth: "visual-category-selection-only",
      expression: "unverified",
      partition: "engineering_qa",
      qualityStatus: "unclassified",
      collectedAt: now,
      expiresAt: "2026-12-31",
      policyVersion: POLICY_VERSION,
    };
  });
  await writeFile(manifestPath, `${manifests.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

  const harness = await createProductionQualityHarness(projectDir);
  const cases = [];
  for (const record of manifests) {
    const metrics = await harness.inspect(join(projectDir, record.relativePath));
    cases.push({
      id: record.id,
      pseudonymousSubjectId: record.pseudonymousSubjectId,
      view: record.view,
      sourceTitle: record.sourceTitle,
      relativePath: record.relativePath,
      width: record.width,
      height: record.height,
      license: record.license,
      sourcePageUrl: record.sourcePageUrl,
      ...metrics,
      uiAccepted: metrics.accepted,
      source: sourceConfig.sourceId,
    });
  }

  const allScores = cases.map((item) => item.quality.score);
  const grouped = Object.groupBy(cases, (item) => item.view);
  const byView = Object.fromEntries(Object.entries(grouped).map(([view, items]) => {
    const scores = items.map((item) => item.quality.score);
    return [view, {
      images: items.length,
      accepted: items.filter((item) => item.uiAccepted).length,
      flagged: items.filter((item) => item.quality.flags.length > 0).length,
      score: { min: Math.min(...scores), median: percentile(scores, 0.5), p95: percentile(scores, 0.95), max: Math.max(...scores) },
    }];
  }));
  const summary = {
    testedAt: new Date().toISOString(),
    source: sourceConfig.sourceId,
    policyVersion: POLICY_VERSION,
    cases: cases.length,
    subjects: cases.length,
    quality: {
      accepted: cases.filter((item) => item.uiAccepted).length,
      rejected: cases.filter((item) => !item.uiAccepted).length,
      flagged: cases.filter((item) => item.quality.flags.length > 0).length,
      score: { min: Math.min(...allScores), median: percentile(allScores, 0.5), p95: percentile(allScores, 0.95), max: Math.max(...allScores) },
      byView,
    },
    pairedProfileStability: null,
    scope: {
      validates: ["网络图片下载", "来源和许可证元数据", "真实图片解码", "生产图片质量门"],
      doesNotValidate: ["同人多视角一致性", "左右侧貌", "关键点准确率", "骨性倾向准确率"],
    },
    notes: ["临时真人头像质量测试", sourceConfig.note, "每名受试者只有一张公开正面候选图，未复制伪造侧貌"],
  };

  await writeFile(casePath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  await writeFile(resultPath, JSON.stringify(summary, null, 2), "utf8");
  const cards = cases.map((item) => {
    const flags = item.quality.flags.length ? item.quality.flags.join("；") : "无";
    return `<article class="card ${item.uiAccepted ? "pass" : "reject"}">
      <img src="/${escapeHtml(item.relativePath)}" alt="${escapeHtml(item.id)}" />
      <div class="body">
        <div class="status">${item.uiAccepted ? "通过" : "拒绝"} · 质量分 ${item.quality.score}</div>
        <h2>${escapeHtml(item.sourceTitle)}</h2>
        <dl>
          <div><dt>输入尺寸</dt><dd>${item.width} × ${item.height}</dd></div>
          <div><dt>亮度 / 对比度</dt><dd>${item.raw.brightness} / ${item.raw.contrast}</dd></div>
          <div><dt>清晰度</dt><dd>${item.raw.sharpness}</dd></div>
          <div><dt>低清放大风险</dt><dd>${item.quality.resamplingRisk}</dd></div>
          <div><dt>质量提示</dt><dd>${escapeHtml(flags)}</dd></div>
          <div><dt>许可证</dt><dd>${escapeHtml(item.license)}</dd></div>
        </dl>
      </div>
    </article>`;
  }).join("\n");
  const reportHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>HeadUp 新真人头像质量回归</title>
    <style>
      *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17202a;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif}
      main{max-width:1500px;margin:auto;padding:38px}header{background:#102b3f;color:white;border-radius:24px;padding:30px 34px;margin-bottom:24px}
      h1{font-size:32px;margin:0 0 10px}.lead{margin:0;color:#dce8f0;font-size:17px}.summary{display:flex;gap:12px;margin-top:22px;flex-wrap:wrap}
      .pill{background:#fff;color:#17364d;border-radius:14px;padding:11px 17px;font-weight:700}.pill.pass{color:#087f5b}.pill.reject{color:#c92a2a}
      .scope{background:#fff7df;border:1px solid #f4d98b;border-radius:16px;padding:16px 20px;margin-bottom:24px;line-height:1.65}
      .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.card{background:white;border-radius:20px;overflow:hidden;box-shadow:0 8px 28px #17364d16;border:3px solid transparent}
      .card.pass{border-color:#b7e4c7}.card.reject{border-color:#ffb4ab}.card img{width:100%;height:340px;object-fit:cover;object-position:center 22%;background:#dfe5e8}
      .body{padding:18px 20px 21px}.status{font-size:20px;font-weight:800;color:#087f5b}.reject .status{color:#c92a2a}h2{font-size:16px;line-height:1.35;margin:8px 0 14px;min-height:43px}
      dl{margin:0;display:grid;gap:7px}dl div{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #edf0f2;padding-top:7px}dt{color:#64727d}dd{margin:0;text-align:right;font-weight:650}
      footer{margin-top:22px;color:#5f6e78;font-size:14px} @media(max-width:1000px){.grid{grid-template-columns:repeat(2,1fr)}}
    </style></head><body><main><header><h1>HeadUp 新真人头像质量回归</h1>
      <p class="lead">${escapeHtml(summary.source)} · ${escapeHtml(summary.testedAt)} · 生产图片质量门</p>
      <div class="summary"><span class="pill">6名真实人物 / 6张新照片</span><span class="pill pass">通过 ${summary.quality.accepted}</span><span class="pill reject">拒绝 ${summary.quality.rejected}</span><span class="pill">分数中位 ${summary.quality.score.median}</span></div></header>
      <section class="scope"><strong>结论边界：</strong>本页验证网络下载、来源记录、图片解码和质量门。每人只有一张官方肖像；没有复制成侧貌，因此不验证左右侧貌、关键点或骨性倾向准确率。</section>
      <section class="grid">${cards}</section><footer>来源：NASA Image and Video Library。仅用于本地教育/信息性研究测试；NASA不认可或背书HeadUp。</footer>
    </main></body></html>`;
  await mkdir(join(projectDir, '.local-archive', 'reports'), { recursive: true });
  await writeFile(htmlReportPath, reportHtml, "utf8");
  await writeFile(join(avatarRoot, "report.txt"), [
    `测试时间: ${summary.testedAt}`,
    `来源: ${summary.source}`,
    `输入数: ${summary.cases}`,
    `通过数: ${summary.quality.accepted}`,
    `拒绝数: ${summary.quality.rejected}`,
    `有提示: ${summary.quality.flagged}`,
    `正面候选通过: ${byView.front?.accepted ?? 0}/${byView.front?.images ?? 0}`,
    "侧貌结论: 不适用（没有把正面复制成侧貌）",
  ].join("\n"), "utf8");
  console.log(JSON.stringify({ ok: true, source: sourceName, resultPath, casePath, manifestPath, htmlReportPath, summary: {
    subjects: summary.subjects,
    images: summary.cases,
    accepted: summary.quality.accepted,
    rejected: summary.quality.rejected,
    flagged: summary.quality.flagged,
  } }, null, 2));
}

main().catch(async (error) => {
  await mkdir(avatarRoot, { recursive: true });
  await writeFile(join(avatarRoot, "avatar-smoke-error.txt"), `${error.stack || error}\n`).catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
