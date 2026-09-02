/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- Metro loads this file with
   require(); the repository lint config declares Node globals only for its own scripts. */
const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// The SDK is a symlink into ../../packages, so Metro has to watch the whole repository. Resolution
// is then pinned to this app's node_modules: without that, the symlinked package's real path lets
// Metro climb to the repository root and load a second copy of React, which breaks every hook.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
