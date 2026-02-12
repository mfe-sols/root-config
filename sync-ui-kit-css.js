/**
 * sync-ui-kit-css.js
 *
 * Copy ui-kit.css và root-config.css từ @mfe-sols/ui-kit package
 * vào public/ folder. Chạy tự động sau pnpm install (postinstall).
 *
 * Source: node_modules/@mfe-sols/ui-kit/css/
 * Target: public/
 */
const fs = require("fs");
const path = require("path");

const CSS_FILES = ["ui-kit.css", "root-config.css"];
const srcDir = path.resolve(__dirname, "node_modules/@mfe-sols/ui-kit/css");
const destDir = path.resolve(__dirname, "public");

if (!fs.existsSync(srcDir)) {
  console.warn("[sync-css] @mfe-sols/ui-kit not installed yet, skipping CSS sync.");
  process.exit(0);
}

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

for (const file of CSS_FILES) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`[sync-css] ${file} → public/${file}`);
  } else {
    console.warn(`[sync-css] ${file} not found in @mfe-sols/ui-kit/css/`);
  }
}
