import fs from "node:fs/promises";
import path from "node:path";

const RESULT_PATH = path.join(process.cwd(), "data", "face-db-real-research", "headup-real-test-result.json");

function toNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

async function main() {
  let raw;
  try {
    raw = await fs.readFile(RESULT_PATH, "utf8");
  } catch (error) {
    console.error(`[ERROR] 无法读取结果文件: ${RESULT_PATH}`);
    console.error(error.message);
    process.exit(2);
  }

  const data = JSON.parse(raw);
  const checks = [
    {
      id: "G-01",
      pass: (d) => d.subjects >= 100,
      detail: (d) => `subjects=${d.subjects}`,
      level: "P0",
    },
    {
      id: "G-02",
      pass: (d) => d.images >= 300,
      detail: (d) => `images=${d.images}`,
      level: "P0",
    },
    {
      id: "G-03",
      pass: (d) => toNumber(d.uiQualityGate?.rejected) <= 3,
      detail: (d) => `rejected=${d.uiQualityGate?.rejected ?? "N/A"}`,
      level: "P0",
    },
    {
      id: "G-04",
      pass: (d) => toNumber(d.uiQualityGate?.accepted) / toNumber(d.images, 1) >= 0.95,
      detail: (d) => `accepted=${d.uiQualityGate?.accepted}/${d.images}`,
      level: "P0",
    },
    {
      id: "G-05",
      pass: (d) => toNumber(d.uiQualityGate?.byView?.front?.accepted) / toNumber(d.uiQualityGate?.byView?.front?.images, 1) >= 0.95,
      detail: (d) => `front=${d.uiQualityGate?.byView?.front?.accepted}/${d.uiQualityGate?.byView?.front?.images}`,
      level: "P0",
    },
    {
      id: "G-06",
      pass: (d) => toNumber(d.uiQualityGate?.byView?.left_profile?.accepted) === toNumber(d.uiQualityGate?.byView?.left_profile?.images),
      detail: (d) => `left_profile=${d.uiQualityGate?.byView?.left_profile?.accepted}/${d.uiQualityGate?.byView?.left_profile?.images}`,
      level: "P1",
    },
    {
      id: "G-07",
      pass: (d) => toNumber(d.uiQualityGate?.byView?.right_profile?.accepted) === toNumber(d.uiQualityGate?.byView?.right_profile?.images),
      detail: (d) => `right_profile=${d.uiQualityGate?.byView?.right_profile?.accepted}/${d.uiQualityGate?.byView?.right_profile?.images}`,
      level: "P1",
    },
    {
      id: "G-08",
      pass: (d) => toNumber(d.pairedProfileStability?.absoluteScoreDifferenceP95) <= 5,
      detail: (d) => `p95=${d.pairedProfileStability?.absoluteScoreDifferenceP95 ?? "N/A"}`,
      level: "P1",
    },
    {
      id: "G-09",
      pass: (d) => toNumber(d.pairedProfileStability?.absoluteScoreDifferenceMax) <= 8,
      detail: (d) => `max=${d.pairedProfileStability?.absoluteScoreDifferenceMax ?? "N/A"}`,
      level: "P1",
    },
    {
      id: "G-10",
      pass: (d) => toNumber(d.uiQualityGate?.score?.median) >= 80,
      detail: (d) => `score_median=${d.uiQualityGate?.score?.median ?? "N/A"}`,
      level: "P1",
    },
  ];

  const report = {
    testedAt: data.testedAt ?? null,
    gates: checks.map((c) => {
      const passed = c.pass(data);
      return {
        id: c.id,
        level: c.level,
        detail: c.detail(data),
        status: passed ? "PASS" : "FAIL",
      };
    }),
    summary: {
      total: checks.length,
      pass: 0,
      fail: 0,
    },
  };

  report.summary.pass = report.gates.filter((g) => g.status === "PASS").length;
  report.summary.fail = report.gates.filter((g) => "FAIL" === g.status).length;
  report.overall = report.summary.fail === 0 ? "PASS" : "FAIL";
  report.artifacts = [
    "data/face-db-real-research/headup-real-test-result.json",
    "data/face-db-real-research/headup-real-test-cases.jsonl",
    "docs/assets/real-53-regression-photo-analysis.png",
  ];

  console.log(JSON.stringify(report, null, 2));

  const outputPath = path.join(process.cwd(), "data", "face-db-real-research", "real-53-regression-gate.json");
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n已写入门禁报告: ${outputPath}`);

  if (report.overall !== "PASS") {
    process.exit(1);
  }
}

await main();
