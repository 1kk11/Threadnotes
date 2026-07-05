const fs = require("fs");
const path = require("path");

const buildId = String(Date.now());
const outPath = path.join(__dirname, "..", "electron", "build-info.json");

fs.writeFileSync(outPath, JSON.stringify({ buildId }, null, 2) + "\n", "utf-8");
console.log("[build-id] stamped:", buildId, "->", outPath);
