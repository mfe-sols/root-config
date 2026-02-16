const { merge } = require("webpack-merge");
const singleSpaDefaults = require("webpack-config-single-spa-ts");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const webpack = require("webpack");
const path = require("path");
const fs = require("fs");

// Load shared workspace .env first, then app-local .env (if any) to override.
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
require("dotenv").config({
  path: path.resolve(__dirname, ".env"),
  override: true,
});

module.exports = (webpackConfigEnv, argv) => {
  const orgName = "org";
  const apiProxyTarget =
    process.env.AUTH_BASE_URL || process.env.API_BASE_URL || "";
  const rootConfigCssPath = path.resolve(__dirname, "public/root-config.css");
  const uiKitCssPath = path.resolve(__dirname, "public/ui-kit.css");
  const rootConfigCssVersion = (() => {
    try {
      const stat = fs.statSync(rootConfigCssPath);
      return String(stat.mtimeMs);
    } catch {
      return String(Date.now());
    }
  })();
  const uiKitCssVersion = (() => {
    try {
      const stat = fs.statSync(uiKitCssPath);
      return String(stat.mtimeMs);
    } catch {
      return String(Date.now());
    }
  })();
  const deployAssetVersion =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    String(Date.now());

  const defaultConfig = singleSpaDefaults({
    orgName,
    projectName: "root-config",
    webpackConfigEnv,
    argv,
    disableHtmlGeneration: true,
  });

  defaultConfig.resolve = defaultConfig.resolve || {};

  // Bundle @mfe-sols/* shared libs (not external)
  const baseExternals = defaultConfig.externals;
  const allowBundle = new Set(["@mfe-sols/i18n", "@mfe-sols/auth"]);
  const customExternals = (context, request, callback) => {
    if (allowBundle.has(request)) {
      return callback();
    }
    if (typeof baseExternals === "function") {
      return baseExternals(context, request, callback);
    }
    if (Array.isArray(baseExternals)) {
      for (const ext of baseExternals) {
        if (typeof ext === "function") {
          let handled = false;
          ext(context, request, (err, result) => {
            if (err) return callback(err);
            if (result !== undefined) {
              handled = true;
              return callback(null, result);
            }
          });
          if (handled) return;
        } else if (typeof ext === "object" && ext[request]) {
          return callback(null, ext[request]);
        }
      }
      return callback();
    }
    return callback();
  };

  // Remove ForkTsCheckerWebpackPlugin (type check separately via tsc --noEmit)
  defaultConfig.plugins = (defaultConfig.plugins || []).filter(
    (p) =>
      p &&
      p.constructor &&
      p.constructor.name !== "ForkTsCheckerWebpackPlugin"
  );

  return merge(defaultConfig, {
    externals: customExternals,
    devServer: {
      ...(defaultConfig.devServer || {}),
      allowedHosts: "all",
      headers: {
        ...((defaultConfig.devServer && defaultConfig.devServer.headers) || {}),
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
      ...(apiProxyTarget
        ? {
            proxy: {
              "/api/auth": {
                target: apiProxyTarget,
                changeOrigin: true,
                secure: false,
              },
              "/api/mfe-toggle": {
                target: apiProxyTarget,
                changeOrigin: true,
                secure: false,
              },
            },
          }
        : {}),
    },
    plugins: [
      new webpack.DefinePlugin({
        "process.env.IMPORTMAP_PROD_URL": JSON.stringify(
          process.env.IMPORTMAP_PROD_URL || ""
        ),
        "process.env.MFE_TOGGLE_URL": JSON.stringify(
          process.env.MFE_TOGGLE_URL || ""
        ),
        "process.env.AUTH_BASE_URL": JSON.stringify(
          process.env.AUTH_BASE_URL || ""
        ),
      }),
      new HtmlWebpackPlugin({
        inject: false,
        template: "src/index.ejs",
        watchFiles: [rootConfigCssPath, uiKitCssPath],
        templateParameters: {
          isLocal: webpackConfigEnv && webpackConfigEnv.isLocal,
          orgName,
          rootConfigCssVersion,
          uiKitCssVersion,
          deployAssetVersion,
        },
      }),
      new HtmlWebpackPlugin({
        inject: false,
        filename: "status.html",
        template: "src/status.ejs",
        templateParameters: {
          isLocal: webpackConfigEnv && webpackConfigEnv.isLocal,
          orgName,
          rootConfigCssVersion,
          uiKitCssVersion,
          deployAssetVersion,
        },
      }),
      // Copy public/ assets into dist/ for production builds
      new CopyPlugin({
        patterns: [
          {
            from: "public",
            to: ".",
            globOptions: {
              ignore: ["**/.DS_Store"],
            },
          },
        ],
      }),
    ],
  });
};
