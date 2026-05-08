#!/usr/bin/env node
/**
 * snap-bridge init — onboarding wizard for new RN projects.
 *
 * Run from the customer repo root:
 *   npx @unicorn-studio/snap-bridge init
 *
 * Walks the designer through:
 *   1. Detecting the project (expo-router root layout)
 *   2. Picking a slug + display name
 *   3. Either creating a new app on the platform (via setup token) or
 *      pasting an existing project token
 *   4. Editing customer files: package.json devDeps, metro.config.js watchFolders
 *   5. Printing the snippet to add to _layout.tsx
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const SNAP_BRIDGE_DIR = resolve(SELF_DIR, "..");

// Where designers' npm install pulls @unicorn-studio/snap-bridge from.
// Override with SNAP_BRIDGE_GIT to test a fork or a feature branch.
const DEFAULT_GIT_URL =
	"git+ssh://git@github.com/hulusi-tunc/snap-bridge.git";
const SNAP_BRIDGE_INSTALL_REF =
	process.env.SNAP_BRIDGE_GIT ?? DEFAULT_GIT_URL;

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

const die = (msg) => {
	console.error(RED(`✗ ${msg}`));
	process.exit(1);
};
const ok = (msg) => console.log(`${GREEN("✓")} ${msg}`);
const info = (msg) => console.log(`${DIM("·")} ${msg}`);

// ── Project detection ──────────────────────────────────────────────────────
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function findWorkspaceRoot(start) {
	let cur = resolve(start);
	while (cur !== "/") {
		const pkgPath = join(cur, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = readJson(pkgPath);
			if (pkg && (pkg.workspaces || pkg.private)) return cur;
		}
		cur = dirname(cur);
	}
	return resolve(start);
}

function findRnAppDir(workspaceRoot) {
	// Look for an app dir with expo dependency and an app/ folder (expo-router).
	const candidates = [];
	const directApp = join(workspaceRoot, "app");
	if (existsSync(directApp) && statSync(directApp).isDirectory()) {
		candidates.push(workspaceRoot);
	}
	const appsDir = join(workspaceRoot, "apps");
	if (existsSync(appsDir) && statSync(appsDir).isDirectory()) {
		for (const name of readdirSync(appsDir)) {
			const full = join(appsDir, name);
			if (
				statSync(full).isDirectory() &&
				existsSync(join(full, "app")) &&
				existsSync(join(full, "package.json"))
			) {
				candidates.push(full);
			}
		}
	}
	for (const c of candidates) {
		const pkg = readJson(join(c, "package.json"));
		const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
		if (deps["expo"] || deps["expo-router"]) return c;
	}
	return null;
}

function findRootLayoutPath(rnAppDir) {
	const candidates = ["app/_layout.tsx", "app/_layout.ts", "app/_layout.jsx"];
	for (const c of candidates) {
		const full = join(rnAppDir, c);
		if (existsSync(full)) return full;
	}
	return join(rnAppDir, "app/_layout.tsx");
}

// ── Prompts ────────────────────────────────────────────────────────────────
async function prompt(rl, question, defaultValue) {
	const suffix = defaultValue ? ` (${DIM(defaultValue)})` : "";
	const answer = (await rl.question(`${question}${suffix}: `)).trim();
	return answer || defaultValue || "";
}

async function promptHidden(rl, question) {
	// readline doesn't natively hide input — print a hint, take it as plain.
	// Acceptable for a setup token (designer can paste).
	console.log(DIM("  (input is visible — use a fresh terminal if you're sharing screen)"));
	const v = (await rl.question(`${question}: `)).trim();
	return v;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ── Platform call ──────────────────────────────────────────────────────────
async function createProject({ url, setupToken, slug, name, platform }) {
	let resp;
	try {
		resp = await fetch(`${url.replace(/\/$/, "")}/api/projects`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${setupToken}`,
			},
			body: JSON.stringify({ slug, name, platform }),
		});
	} catch (err) {
		throw new Error(`Could not reach platform at ${url}: ${err.message}`);
	}
	const text = await resp.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`Platform returned non-JSON (${resp.status}): ${text.slice(0, 200)}`);
	}
	if (!resp.ok) {
		throw new Error(`${resp.status} ${json.error ?? text}`);
	}
	return json;
}

// ── File edits ─────────────────────────────────────────────────────────────
function relForFile(fromDir, toAbs) {
	const rel = relative(fromDir, toAbs);
	return rel.startsWith(".") ? rel : `./${rel}`;
}

function addBridgeDep(rootPkgPath) {
	const pkg = readJson(rootPkgPath);
	if (!pkg) die(`Could not read ${rootPkgPath}`);
	const installRef = SNAP_BRIDGE_INSTALL_REF;
	pkg.devDependencies = pkg.devDependencies ?? {};
	const existing = pkg.devDependencies["@unicorn-studio/snap-bridge"];
	if (existing && existing === installRef)
		return { changed: false, installRef };
	pkg.devDependencies["@unicorn-studio/snap-bridge"] = installRef;
	// Re-sort devDependencies for deterministic output
	const sorted = {};
	for (const k of Object.keys(pkg.devDependencies).sort()) {
		sorted[k] = pkg.devDependencies[k];
	}
	pkg.devDependencies = sorted;
	writeFileSync(rootPkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
	return { changed: true, installRef };
}

const METRO_CONFIG_TEMPLATE = `// Generated/extended by @unicorn-studio/snap-bridge init.
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(projectRoot);

// Follow file: deps that live outside the workspace.
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
`;

function patchMetroConfig(rnAppDir) {
	const target = join(rnAppDir, "metro.config.js");
	if (!existsSync(target)) {
		writeFileSync(target, METRO_CONFIG_TEMPLATE, "utf8");
		return { wrote: true, mode: "created" };
	}
	const cur = readFileSync(target, "utf8");
	if (cur.includes("@unicorn-studio/snap-bridge")) {
		return { wrote: false, mode: "already-configured" };
	}
	// Heuristic: append a note. Auto-rewriting arbitrary metro configs is risky.
	const note = `\n\n// snap-bridge init (${new Date().toISOString().slice(0, 10)}): your\n// metro.config.js needs to follow the @unicorn-studio/snap-bridge file: dep\n// into watchFolders, otherwise Metro can't resolve the package across the\n// workspace boundary. Compare your config against the template at\n// ${join(SNAP_BRIDGE_DIR, "examples/metro.config.js")}\n`;
	writeFileSync(target, cur + note, "utf8");
	return { wrote: true, mode: "annotated" };
}

function writeUnicornDir(rnAppDir, payload) {
	const dir = join(rnAppDir, ".unicorn");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(
		join(dir, "project.json"),
		JSON.stringify(payload, null, 2) + "\n",
		"utf8",
	);
	const ignorePath = join(dir, ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "project.json\n", "utf8");
	}
}

function captureProjectsPath() {
	return join(homedir(), "Library", "Application Support", "UnicornCapture", "projects.json");
}

function registerWithCapture(payload) {
	const path = captureProjectsPath();
	mkdirSync(dirname(path), { recursive: true });
	let list = [];
	if (existsSync(path)) {
		try {
			list = JSON.parse(readFileSync(path, "utf8"));
			if (!Array.isArray(list)) list = [];
		} catch {
			list = [];
		}
	}
	const idx = list.findIndex((p) => p.slug === payload.slug);
	if (idx >= 0) list[idx] = { ...list[idx], ...payload };
	else list.push(payload);
	writeFileSync(path, JSON.stringify(list, null, 2) + "\n", "utf8");
	return path;
}

// ── Snippet for _layout.tsx ────────────────────────────────────────────────
function layoutSnippet(slug) {
	return `// ── @unicorn-studio/snap-bridge wiring ──────────────────────────────────
// Add the following imports to the TOP of your root layout file:
import { useEffect } from "react";
import { usePathname, useSegments } from "expo-router";
import { installSnapBridge, setSnapState } from "@unicorn-studio/snap-bridge";

// At the module level (outside the component), call once:
installSnapBridge({ projectId: ${JSON.stringify(slug)} });

// Inside your root component, after any \`useFonts\` calls:
const pathname = usePathname();
const segments = useSegments();
useEffect(() => {
  setSnapState({ route: pathname, navStack: segments });
}, [pathname, segments]);
`;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
	const cwd = process.cwd();
	console.log("");
	console.log(BOLD("snap-bridge init"));
	console.log(DIM("  customer-repo onboarding wizard"));
	console.log("");

	// Detect
	const workspaceRoot = findWorkspaceRoot(cwd);
	const rnAppDir = findRnAppDir(workspaceRoot);
	if (!rnAppDir) {
		die(
			"Couldn't find an Expo / RN app under this workspace.\n  Looked for `app/` + expo dependency under `.` and `apps/*`.",
		);
	}
	const rootPkgPath = join(workspaceRoot, "package.json");
	const layoutPath = findRootLayoutPath(rnAppDir);

	ok(`workspace root: ${workspaceRoot}`);
	ok(`RN app dir:    ${rnAppDir}`);
	ok(`root layout:   ${relative(workspaceRoot, layoutPath)}`);
	console.log("");

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	const defaultSlug = basename(workspaceRoot)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	let slug = "";
	while (!SLUG_RE.test(slug)) {
		slug = await prompt(rl, "Project slug", defaultSlug);
		if (!SLUG_RE.test(slug)) {
			console.log(RED("  must be lowercase kebab-case (a–z, 0–9, hyphens)."));
		}
	}
	const name = await prompt(rl, "Display name", slug);
	const platform = (await prompt(rl, "Platform (ios | android | web)", "ios")).toLowerCase();
	if (!["ios", "android", "web"].includes(platform)) {
		die(`Invalid platform "${platform}".`);
	}

	console.log("");
	const haveToken = (await prompt(rl, "Already have a project token? (y/N)", "n")).toLowerCase();

	let projectToken;
	let platformUrl;
	if (haveToken === "y" || haveToken === "yes") {
		platformUrl = await prompt(rl, "Platform URL", "http://localhost:3010");
		projectToken = await promptHidden(rl, "Project token (pgt_…)");
		if (!projectToken.startsWith("pgt_")) {
			die("Project token should start with 'pgt_'.");
		}
	} else {
		platformUrl = await prompt(rl, "Platform URL", "http://localhost:3010");
		const setupToken = await promptHidden(rl, "Setup token (server-side SETUP_TOKEN)");
		if (!setupToken) die("Setup token is required to create a new project.");
		try {
			const result = await createProject({
				url: platformUrl,
				setupToken,
				slug,
				name,
				platform,
			});
			projectToken = result.projectToken;
			ok(`platform: created app "${result.slug}" → id ${result.id}`);
		} catch (err) {
			die(`Platform call failed: ${err.message}`);
		}
	}

	console.log("");
	info("Editing files…");

	// Edit root package.json
	const dep = addBridgeDep(rootPkgPath);
	if (dep.changed) {
		ok(
			`added "@unicorn-studio/snap-bridge": "${dep.installRef}" to ${relative(workspaceRoot, rootPkgPath)}`,
		);
	} else {
		info(
			`@unicorn-studio/snap-bridge already in ${relative(workspaceRoot, rootPkgPath)}`,
		);
	}

	// Patch metro.config.js
	const metro = patchMetroConfig(rnAppDir);
	const metroRel = relative(workspaceRoot, join(rnAppDir, "metro.config.js"));
	if (metro.mode === "created") ok(`wrote ${metroRel}`);
	else if (metro.mode === "annotated") {
		console.log(YELLOW(`! ${metroRel} already exists — appended a TODO note. Verify it follows the snap-bridge file: dep into watchFolders.`));
	} else info(`${metroRel} already configured`);

	// .unicorn/project.json (gitignored, local reference)
	writeUnicornDir(rnAppDir, {
		slug,
		name,
		platform,
		projectToken,
		uploadUrl: `${platformUrl.replace(/\/$/, "")}/api/captures/upload`,
		createdAt: new Date().toISOString(),
	});
	ok(`wrote ${relative(workspaceRoot, join(rnAppDir, ".unicorn/project.json"))} (gitignored)`);

	// Register with Capture's project list (Capture reads on startup)
	const capturePath = registerWithCapture({
		slug,
		name,
		platform,
		projectToken,
		uploadUrl: `${platformUrl.replace(/\/$/, "")}/api/captures/upload`,
		registeredAt: new Date().toISOString(),
	});
	ok(`registered with Unicorn Capture (${capturePath})`);

	// Done
	rl.close();
	console.log("");
	console.log(BOLD("─── Add to your root layout ───"));
	console.log("");
	console.log(layoutSnippet(slug));
	console.log(BOLD("─── Then run ───"));
	console.log("");
	console.log(`  cd ${relative(cwd, workspaceRoot) || "."}`);
	console.log("  npm install      # (or pnpm/yarn)");
	console.log("  # restart Metro with --clear so the new file: dep resolves");
	console.log("");
	console.log(BOLD("─── Capture upload ───"));
	console.log("");
	console.log(`When running Unicorn Capture, set:`);
	console.log(`  SNAP_UPLOAD_URL=${platformUrl}/api/captures/upload`);
	console.log(`  SNAP_UPLOAD_TOKEN=${projectToken}`);
	console.log("");
	console.log(GREEN("Done. Open Unicorn Capture, switch to iOS Sim mode, snap away."));
}

main().catch((err) => {
	console.error(RED(`\n✗ ${err.message}`));
	if (err.stack && process.env.DEBUG) console.error(DIM(err.stack));
	process.exit(1);
});
