// Example Expo Router monorepo metro.config.js with snap-bridge wiring.
// Copy/merge into your apps/<your-app>/metro.config.js.
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(projectRoot);

// snap-bridge lives outside the workspace as a `file:` dep. Metro needs the
// real path in watchFolders or it can't resolve modules across the boundary.
const externalLinkedPackages = ["@unicorn-studio/snap-bridge"];
const externalRealPaths = externalLinkedPackages
  .map((pkg) => {
    try {
      return fs.realpathSync(path.join(workspaceRoot, "node_modules", pkg));
    } catch {
      return null;
    }
  })
  .filter(Boolean);

config.watchFolders = [workspaceRoot, ...externalRealPaths];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
