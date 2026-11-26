import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function isMain(moduleUrl, argv1 = process.argv[1]) {
  return Boolean(argv1) && real(argv1) === real(fileURLToPath(moduleUrl));
}
export const PLUGINS_DIR = join(ROOT, "plugins");
export const PACKAGES_DIR = join(ROOT, "packages");
export const PLATFORMS = ["universal", "macos-arm64", "macos-x64", "linux-x64", "linux-arm64", "windows-x64"];
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readJsonIfThere = (file) => (existsSync(file) ? readJson(file) : null);

export function jsPackageDir(plugin) {
  if (plugin.name === "cli") return join(plugin.dir, "main");
  return existsSync(join(plugin.dir, "package.json")) ? plugin.dir : null;
}

export function loadPlugin(name, root = ROOT) {
  const dir = join(root, "plugins", name);
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) throw new Error(`there's no plugins/${name}/plugin.json`);
  const manifest = readJson(file);
  const plugin = { name, dir, rel: `plugins/${name}`, manifest };
  const pkgDir = jsPackageDir(plugin);
  plugin.packageDir = pkgDir;
  plugin.packageJson = pkgDir ? readJsonIfThere(join(pkgDir, "package.json")) : null;
  return plugin;
}

export function listPlugins(root = ROOT) {
  const base = join(root, "plugins");
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "plugin.json")))
    .map((entry) => entry.name)
    .sort()
    .map((name) => loadPlugin(name, root));
}

export function listPackages(root = ROOT) {
  const base = join(root, "packages");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "package.json")))
    .map((entry) => ({ dir: join(base, entry.name), rel: `packages/${entry.name}`, packageJson: readJson(join(base, entry.name, "package.json")) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

export const idName = (id) => id.split("/")[1] ?? id;

export function isNative(manifest) {
  if (manifest.sidecar !== undefined) return true;
  if (Array.isArray(manifest.contributes?.programs) && manifest.contributes.programs.length > 0) return true;
  const control = manifest.permissions?.control;
  return control !== undefined && control !== false;
}

export function expandAsset(template, values) {
  return template.replace(/\{version\}/g, values.version).replace(/\{platform\}/g, values.platform).replace(/\{name\}/g, values.name);
}

export function releaseAssets(manifest) {
  const release = manifest.release ?? {};
  const values = { version: manifest.version, name: idName(manifest.id) };
  if (release.assets && Object.keys(release.assets).length) {
    return Object.entries(release.assets)
      .filter(([platform]) => PLATFORMS.includes(platform))
      .map(([platform, template]) => ({ platform, name: expandAsset(template, { ...values, platform }) }));
  }
  const template = release.asset ?? "{name}-{version}.tar.gz";
  return [{ platform: "universal", name: expandAsset(template, { ...values, platform: "universal" }) }];
}

export function tagPrefix(manifest) {
  return manifest.release?.tagPrefix ?? "v";
}

export function releaseInfo(plugin) {
  const { manifest } = plugin;
  const assets = releaseAssets(manifest);
  return {
    dir: plugin.rel,
    name: plugin.name,
    id: manifest.id,
    title: manifest.name,
    version: manifest.version,
    tag: `${tagPrefix(manifest)}${manifest.version}`,
    tagPrefix: tagPrefix(manifest),
    repo: manifest.release?.github ?? null,
    prerelease: manifest.version.includes("-"),
    native: isNative(manifest),
    platforms: assets.map((asset) => asset.platform),
    assets,
  };
}

export function findByTag(tag, plugins = listPlugins()) {
  const matches = plugins
    .filter((plugin) => {
      const prefix = tagPrefix(plugin.manifest);
      return tag.startsWith(prefix) && SEMVER.test(tag.slice(prefix.length));
    })
    .sort((a, b) => tagPrefix(b.manifest).length - tagPrefix(a.manifest).length);
  if (!matches.length) throw new Error(`no plugin's release.tagPrefix matches the tag ${tag}`);
  const plugin = matches[0];
  const version = tag.slice(tagPrefix(plugin.manifest).length);
  if (version !== plugin.manifest.version) {
    throw new Error(`the tag ${tag} names ${version}, and ${plugin.rel}/plugin.json is ${plugin.manifest.version}: bump plugin.json or tag ${releaseInfo(plugin).tag}`);
  }
  return plugin;
}

const SHARED = [
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^pnpm-lock\.yaml$/,
  /^\.pnpmfile\.cjs$/,
  /^scripts\//,
  /^\.github\/actions\//,
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/workflows\/release-plugin\.yml$/,
];
const IGNORED_IN_PLUGIN = { cli: [/^README\.md$/, /^docs\//, /^bench\//] };

function dependsOn(packageJson, names) {
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  return fields.some((field) => Object.keys(packageJson?.[field] ?? {}).some((name) => names.has(name)));
}

export function affected(paths, plugins = listPlugins(), packages = listPackages()) {
  const all = plugins.map((plugin) => plugin.name);
  const hit = new Set();
  const touchedPackages = new Set();
  for (const raw of paths) {
    const path = raw.replace(/^\.\//, "");
    if (!path) continue;
    if (SHARED.some((rule) => rule.test(path))) return { plugins: all, shared: true, packages: true };
    if (path.startsWith(".github/release/")) {
      hit.add("cli");
      continue;
    }
    const inPlugin = /^plugins\/([^/]+)\/(.*)$/.exec(path);
    if (inPlugin) {
      const [, name, rest] = inPlugin;
      if (!all.includes(name)) continue;
      if ((IGNORED_IN_PLUGIN[name] ?? []).some((rule) => rule.test(rest))) continue;
      hit.add(name);
      continue;
    }
    const inPackage = /^packages\/([^/]+)\//.exec(path);
    if (inPackage) {
      const pkg = packages.find((entry) => entry.rel === `packages/${inPackage[1]}`);
      if (pkg) touchedPackages.add(pkg.packageJson.name);
      else return { plugins: all, shared: true, packages: true };
    }
  }
  let grew = touchedPackages.size > 0;
  while (grew) {
    grew = false;
    for (const pkg of packages) {
      if (!touchedPackages.has(pkg.packageJson.name) && dependsOn(pkg.packageJson, touchedPackages)) {
        touchedPackages.add(pkg.packageJson.name);
        grew = true;
      }
    }
  }
  for (const plugin of plugins) if (touchedPackages.size && dependsOn(plugin.packageJson, touchedPackages)) hit.add(plugin.name);
  return { plugins: all.filter((name) => hit.has(name)), shared: false, packages: touchedPackages.size > 0 };
}
