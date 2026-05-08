#!/usr/bin/env node
/**
 * snap-bridge-setup — one-shot per-project setup.
 *
 * Idempotent. Run from the RN app's package dir (where its package.json
 * + app/ live). Does everything you'd otherwise do by hand:
 *
 *   1. Installs react-native-view-shot if it isn't already there
 *   2. Creates hooks/useSnapTarget.ts if the file doesn't exist
 *   3. Runs snap-flows-scan to (re)generate snap-flows.ts from app/
 *   4. Verifies _layout wiring; prints the missing snippet if any
 *
 * Re-run any time. Won't clobber user edits.
 *
 * Usage:
 *   pnpm exec snap-bridge-setup              # auto-detect cwd
 *   pnpm exec snap-bridge-setup --skip-deps  # don't run npm install
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, cwd, exit } from "node:process";

const SELF = fileURLToPath(import.meta.url);

// ─── arg parsing ───────────────────────────────────────────────────────────
const args = argv.slice(2);
let skipDeps = false;
let appDirArg = null;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--skip-deps") skipDeps = true;
	else if (a === "--app-dir" && args[i + 1]) appDirArg = args[++i];
	else if (a === "-h" || a === "--help") {
		console.log(`
snap-bridge-setup — one-shot setup for full-page capture in a customer RN project.

Usage:
  pnpm exec snap-bridge-setup [options]

Options:
  --skip-deps       Skip the react-native-view-shot install step.
  --app-dir <path>  Path to the Expo Router app/ directory (auto-detected).
  -h, --help        Show this help.

What it does (idempotent):
  1. Installs react-native-view-shot if missing
  2. Writes hooks/useSnapTarget.ts if missing
  3. Runs snap-flows-scan to (re)generate snap-flows.ts
  4. Validates _layout.tsx wiring
`);
		exit(0);
	}
}

// ─── helpers ───────────────────────────────────────────────────────────────
function detectPackageManager(rootDir) {
	const has = (f) => existsSync(join(rootDir, f));
	try {
		const pkgPath = join(rootDir, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
			const pm = pkg.packageManager;
			if (typeof pm === "string") {
				if (pm.startsWith("pnpm")) return "pnpm";
				if (pm.startsWith("yarn")) return "yarn";
				if (pm.startsWith("npm")) return "npm";
			}
		}
	} catch {}
	if (has("pnpm-lock.yaml")) return "pnpm";
	if (has("yarn.lock")) return "yarn";
	return "npm";
}

function findRepoRoot(start) {
	let dir = start;
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "pnpm-lock.yaml"))) return dir;
		if (existsSync(join(dir, "package-lock.json"))) return dir;
		if (existsSync(join(dir, "yarn.lock"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return start;
}

function findAppDir() {
	if (appDirArg) {
		const abs = resolve(appDirArg);
		if (existsSync(abs)) return abs;
		console.error(`--app-dir not found: ${abs}`);
		exit(1);
	}
	for (const candidate of ["app", "mobile/app", "apps/mobile/app", "src/app"]) {
		const full = join(cwd(), candidate);
		if (existsSync(full)) return full;
	}
	console.error(
		"Could not find an Expo Router app/ directory. Pass --app-dir.",
	);
	exit(1);
}

function isPkgInstalled(packagePkgPath, name) {
	try {
		const pkg = JSON.parse(readFileSync(packagePkgPath, "utf8"));
		return Boolean(
			pkg.dependencies?.[name] ||
				pkg.devDependencies?.[name] ||
				pkg.peerDependencies?.[name],
		);
	} catch {
		return false;
	}
}

function step(emoji, title) {
	console.log(`\n${emoji}  ${title}`);
}

// ─── 0. Where are we? ──────────────────────────────────────────────────────
const appDir = findAppDir();
const packageDir = dirname(appDir); // mobile/ in monorepo, project root otherwise
const repoRoot = findRepoRoot(packageDir);
const pm = detectPackageManager(repoRoot);

console.log(`Package dir: ${relative(cwd(), packageDir) || packageDir}`);
console.log(`Repo root:   ${relative(cwd(), repoRoot) || repoRoot}`);
console.log(`Manager:     ${pm}`);

// ─── 1. Install react-native-view-shot ─────────────────────────────────────
step("📦", "Checking react-native-view-shot");
const pkgPath = join(packageDir, "package.json");
const installed = isPkgInstalled(pkgPath, "react-native-view-shot");
if (installed) {
	console.log("   ✓ already installed");
} else if (skipDeps) {
	console.log("   ⊘ skipped (--skip-deps); install with:");
	console.log(`     ${pm} add react-native-view-shot`);
} else {
	console.log(`   Running: ${pm} add react-native-view-shot`);
	const installArgs =
		pm === "yarn"
			? ["add", "react-native-view-shot"]
			: ["install", "react-native-view-shot"];
	const r = spawnSync(pm, installArgs, {
		cwd: packageDir,
		stdio: "inherit",
	});
	if (r.status !== 0) {
		console.error("   ✗ install failed — fix the error above and re-run.");
		exit(1);
	}
	console.log("   ✓ installed");
	console.log(
		"   ↪ Don't forget `cd ios && pod install` on the iOS native side.",
	);
}

// ─── 2. Write the useSnapTarget hook ───────────────────────────────────────
step("🪝", "Ensuring useSnapTarget hook");
const hookDir = join(packageDir, "hooks");
const hookPath = join(hookDir, "useSnapTarget.ts");
if (existsSync(hookPath)) {
	console.log(`   ✓ already exists at ${relative(cwd(), hookPath) || hookPath}`);
} else {
	const hookSrc = `import { useEffect, useRef } from "react";
import { registerSnapTarget } from "@unicorn-studio/snap-bridge";

/**
 * Bridge'in full-page capture yapabilmesi için ekrandaki kök ScrollView'i
 * tanıt. Component unmount olunca otomatik temizlenir.
 *
 * Kullanım:
 *   const ref = useSnapTarget();
 *   return <ScrollView ref={ref}>...</ScrollView>;
 */
export function useSnapTarget() {
	const ref = useRef(null);
	useEffect(() => {
		registerSnapTarget(ref);
		return () => registerSnapTarget(null);
	}, []);
	return ref;
}
`;
	mkdirSync(hookDir, { recursive: true });
	writeFileSync(hookPath, hookSrc);
	console.log(`   ✓ wrote ${relative(cwd(), hookPath) || hookPath}`);
}

// ─── 3. Run snap-flows-scan ────────────────────────────────────────────────
step("🔄", "Running snap-flows-scan");
const scanScript = join(dirname(SELF), "snap-flows-scan.mjs");
const scanResult = spawnSync(process.execPath, [scanScript], {
	cwd: packageDir,
	stdio: "inherit",
});
if (scanResult.status !== 0) {
	console.error("   ✗ snap-flows-scan failed — see error above.");
	exit(1);
}

// ─── 4. Layout wiring already validated by snap-flows-scan, end with summary ──
step("🎯", "Next steps");
console.log(`   1. (one-time) bump snap-bridge in package.json to v0.3.0+ if you haven't:`);
console.log(`        ${pm} ${pm === "yarn" ? "add" : "install"} --save-dev "github:hulusi-tunc/snap-bridge#v0.3.0"`);
console.log("");
console.log(
	"   2. Apply useSnapTarget to your screens. Hand this prompt to Claude Code:",
);
console.log("");
console.log(
	"        Apply useSnapTarget to every screen under app/ that has a root",
);
console.log(
	"        ScrollView. The hook lives at hooks/useSnapTarget.ts. Per-file:",
);
console.log("        - import { useSnapTarget } from '<relative path>';");
console.log("        - const ref = useSnapTarget();");
console.log("        - <ScrollView ref={ref}>...");
console.log("        Skip screens without a ScrollView.");
console.log("");
console.log(
	"   3. Restart your RN app, then in Capture click ↻ Refresh on the project,",
);
console.log("      then 📸 Snap. You should now get full-page captures.");
console.log("");
console.log("✓ Setup complete.");
