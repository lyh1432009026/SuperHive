/**
 * Electron Forge 配置。scripts/stage.mjs 把它复制进 .stage/app，Forge 在那里打包
 * （`electron-forge package .stage/app`），所以这里的路径都相对 .stage/app。
 *
 * 需要证书或对外发布的部分（代码签名、公证、自动更新、发布到 GitHub Release）这次都没开，
 * 位置留在下面的 TODO 里，见 apps/desktop/README.md「发布前要准备的」。
 */
const path = require("node:path");
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const { prune: pruneNatives } = require("./prune-natives.cjs");

// scripts/forge.mjs 传进来；Forge 加载配置时 __dirname 不一定是 .stage/app
const desktopDir = process.env.SUPERHIVE_DESKTOP_DIR ?? path.resolve(__dirname, "../..");
const { version } = require(path.join(desktopDir, "package.json"));

/** Windows 安装包文件名带版本和架构，和 Release 上的文件名一致，不用再手动改名 */
function setupExeName(arch) {
  return `SuperHive-${version}-win-${arch}-Setup.exe`;
}

module.exports = {
  outDir: path.join(desktopDir, "out"),
  packagerConfig: {
    name: "SuperHive",
    executableName: process.platform === "linux" ? "superhive" : "SuperHive",
    appBundleId: "dev.superhive.desktop",
    appCategoryType: "public.app-category.developer-tools",
    icon: path.join(desktopDir, "build/icon"),
    // 原生模块和 node-pty 的 spawn-helper 必须放在 asar 外面才能加载 / 执行
    asar: {
      unpack: "**/{*.node,spawn-helper,winpty-agent.exe,winpty.dll,conpty.dll,OpenConsole.exe}",
    },
    // 运行时依赖在 stage 里已经是 npm 装好的生产依赖，不用再裁剪
    prune: false,
    ignore: [/^\/forge\.config\.cjs$/, /^\/prune-natives\.cjs$/, /^\/out($|\/)/, /\.map$/],
    // 原生模块只留目标平台的预编译，去掉调试符号和 C++ 源码
    afterCopy: [pruneNatives],
    // TODO(签名)：osxSign: {}、osxNotarize: { appleId, appleIdPassword, teamId }，需要 Apple Developer 证书
    // TODO(签名)：Windows 用 windowsSign（证书或 Azure Trusted Signing）
  },
  rebuildConfig: {
    // better-sqlite3 13 和 node-pty 都是 N-API 预编译包；只有 Linux 上的 node-pty 要按 Electron 编
    onlyModules: process.platform === "linux" ? ["node-pty"] : [],
  },
  makers: [
    { name: "@electron-forge/maker-dmg", platforms: ["darwin"], config: { format: "ULFO" } },
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "linux", "win32"] },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      // config 写成函数：Forge 按目标架构调用（maker-base 的 prepareConfig）
      config: (arch) => ({ name: "SuperHive", setupExe: setupExeName(arch) }),
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: { name: "superhive", productName: "SuperHive", categories: ["Development"] },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: { name: "superhive", productName: "SuperHive", categories: ["Development"] },
      },
    },
  ],
  // TODO(发布)：publishers: [{ name: "@electron-forge/publisher-github", config: { repository: { owner, name }, draft: true } }]
  // TODO(自动更新)：签名后可用 update-electron-app（update.electronjs.org）或自建更新源
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      // Electron 不能被当成任意 Node 用；本机 Agent 走 --superhive-cli，只跑包里的 CLI
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};
