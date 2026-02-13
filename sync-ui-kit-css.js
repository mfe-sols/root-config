/**
 * sync-ui-kit-css.js
 *
 * Đồng bộ CSS shared từ ui-kit vào public/.
 * Mặc định chỉ sync `ui-kit.css` để tránh ghi đè style riêng của root-config.
 * Có thể bật sync `root-config.css` từ ui-kit bằng SYNC_ROOT_CONFIG_CSS=true khi cần migrate.
 */
const fs = require("fs");
const path = require("path");

const cssFiles = ["ui-kit.css"];
if (process.env.SYNC_ROOT_CONFIG_CSS === "true") {
  cssFiles.push("root-config.css");
}
const destDir = path.resolve(__dirname, "public");
const sourceCandidates = [
  // Monorepo source of truth (preferred during development)
  path.resolve(__dirname, "../../libs/ui-kit/css"),
  // Local install inside app folder (if present)
  path.resolve(__dirname, "node_modules/@mfe-sols/ui-kit/css"),
  // Workspace-level install (pnpm workspace root)
  path.resolve(__dirname, "../../node_modules/@mfe-sols/ui-kit/css"),
];

const srcDir = sourceCandidates.find((candidate) => fs.existsSync(candidate));

if (!srcDir) {
  console.warn(
    "[sync-css] No CSS source found (libs/ui-kit/css or @mfe-sols/ui-kit package), skipping."
  );
  process.exit(0);
}

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

console.log(`[sync-css] Source: ${srcDir}`);

for (const file of cssFiles) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`[sync-css] ${file} → public/${file}`);
  } else {
    console.warn(`[sync-css] ${file} not found in @mfe-sols/ui-kit/css/`);
  }
}

if (process.env.SYNC_ROOT_CONFIG_CSS !== "true") {
  console.log("[sync-css] Keeping public/root-config.css as app-owned stylesheet.");
}
