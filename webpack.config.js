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

const normalizeBaseUrl = (value) => {
  if (!value || typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
};

const isLocalBaseUrl = (value) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(value);

module.exports = (webpackConfigEnv, argv) => {
  const orgName = "org";
  const isLocalBuild = Boolean(webpackConfigEnv && webpackConfigEnv.isLocal);
  const configuredApiBaseUrl = normalizeBaseUrl(
    process.env.AUTH_BASE_URL || process.env.API_BASE_URL || ""
  );
  const publicApiBaseUrl =
    configuredApiBaseUrl && (!isLocalBaseUrl(configuredApiBaseUrl) || isLocalBuild)
      ? configuredApiBaseUrl
      : isLocalBuild
      ? "http://localhost:7272"
      : "";
  const authProxyTarget = publicApiBaseUrl;
  const toggleProxyTarget = process.env.MFE_TOGGLE_BASE_URL || "";
  let localDisabledApps = [];
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
  defaultConfig.resolve.alias = {
    ...(defaultConfig.resolve.alias || {}),
    "@mfe-sols/auth": resolvedAuthEntry,
  };

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
      setupMiddlewares: (middlewares, devServer) => {
        if (typeof defaultConfig.devServer?.setupMiddlewares === "function") {
          middlewares = defaultConfig.devServer.setupMiddlewares(middlewares, devServer);
        }

        if (!toggleProxyTarget && devServer?.app) {
          devServer.app.get("/api/mfe-toggle", (_req, res) => {
            res.json({ disabled: localDisabledApps });
          });

          devServer.app.post("/api/mfe-toggle", (req, res) => {
            let rawBody = "";

            req.on("data", (chunk) => {
              rawBody += String(chunk);
            });

            req.on("end", () => {
              try {
                const payload = rawBody ? JSON.parse(rawBody) : {};
                const disabled = Array.isArray(payload?.disabled)
                  ? payload.disabled.filter((item) => typeof item === "string")
                  : null;

                if (!disabled) {
                  res.status(400).json({ error: "disabled must be an array of app names" });
                  return;
                }

                localDisabledApps = disabled;
                res.json({ disabled: localDisabledApps });
              } catch {
                res.status(400).json({ error: "invalid JSON payload" });
              }
            });
          });
        }

        return middlewares;
      },
      ...((authProxyTarget || toggleProxyTarget)
        ? {
            proxy: {
              ...(authProxyTarget
                ? {
                    "/api/auth": {
                      target: authProxyTarget,
                      changeOrigin: true,
                      secure: false,
                    },
                  }
                : {}),
              ...(toggleProxyTarget
                ? {
                    "/api/mfe-toggle": {
                      target: toggleProxyTarget,
                      changeOrigin: true,
                      secure: false,
                      proxyTimeout: 10000,
                      timeout: 10000,
                      logLevel: "silent",
                      onError: (_err, req, res) => {
                        if (res.headersSent) return;
                        if (req.method === "GET") {
                          res.writeHead(200, { "Content-Type": "application/json" });
                          res.end(JSON.stringify({ disabled: [] }));
                          return;
                        }
                        res.writeHead(502, { "Content-Type": "application/json" });
                        res.end(
                          JSON.stringify({ error: "mfe-toggle proxy unavailable" })
                        );
                      },
                    },
                  }
                : {}),
              ...(authProxyTarget
                ? {
                    "/api/kahoot-mini": {
                      target: authProxyTarget,
                      changeOrigin: true,
                      secure: false,
                    },
                  }
                : {}),
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
          publicApiBaseUrl
        ),
        "process.env.API_BASE_URL": JSON.stringify(
          publicApiBaseUrl
        ),
      }),
      new HtmlWebpackPlugin({
        inject: false,
        template: "src/index.ejs",
        watchFiles: [rootConfigCssPath, uiKitCssPath],
        templateParameters: {
          isLocal: isLocalBuild,
          orgName,
          authBaseUrl: publicApiBaseUrl,
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
          isLocal: isLocalBuild,
          orgName,
          authBaseUrl: publicApiBaseUrl,
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
