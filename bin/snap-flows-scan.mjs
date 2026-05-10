#!/usr/bin/env node
/**
 * snap-flows-scan
 *
 * Walks an Expo Router `app/` directory and emits a `snap-flows.ts`
 * skeleton that conforms to `@unicorn-studio/snap-bridge`'s
 * `SnapFlowsDeclaration` schema.
 *
 * Conventions:
 *   - Folders → flows / sub-flows
 *   - Files (`.tsx`/`.ts`/`.jsx`/`.js`) → screens
 *   - `_layout.*`, `_*` → skipped (Expo Router layouts)
 *   - `(group)` segments → stripped from the route, ignored for grouping
 *   - `[param]` → `:param` in the route
 *   - Auth-shaped names (sign-in, sign-up, login, register, …) auto-group
 *     into an "auth" flow
 *
 * Usage:
 *   pnpm exec snap-flows-scan [--app-dir <path>] [--out <path>] [--dry-run]
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { argv, cwd, exit } from "node:process";

// ════════════════════════════════════════════════════════════════════════════
// constants + helpers (declared first so the entry-point block below can
// freely reference them — node ESM doesn't hoist `const`s)
// ════════════════════════════════════════════════════════════════════════════

const SCREEN_EXT = /\.(tsx|ts|jsx|js)$/;

const AUTH_PATTERNS = new Set([
	"sign-in",
	"sign-up",
	"signin",
	"signup",
	"login",
	"logout",
	"register",
	"forgot-password",
	"reset-password",
	"verify",
	"verify-email",
	"otp",
]);

function fileToRoute(relPath) {
	let r = relPath
		.replace(SCREEN_EXT, "")
		.replace(/\.(ios|android|native|web)$/, "") // platform-specific files
		.replace(/\/index$/, "");
	const segs = r
		.split("/")
		.filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
	let route = `/${segs.join("/")}`;
	route = route.replace(/\[(\.{3})?(\w+)\]/g, ":$2");
	if (route === "") route = "/";
	if (!route.startsWith("/")) route = `/${route}`;
	return route === "//" ? "/" : route;
}

function topSegment(route) {
	if (route === "/") return "main";
	const segs = route.split("/").filter(Boolean);
	const first = segs[0] ?? "main";
	if (AUTH_PATTERNS.has(first)) return "auth";
	return first.replace(/^:/, "");
}

function deriveScreenName(route) {
	if (route === "/") return "Home";
	const segs = route.split("/").filter(Boolean);
	const last = segs[segs.length - 1] ?? "screen";
	if (last.startsWith(":")) {
		// Dynamic param at the end — name from the parent segment
		// (e.g. `/reservation/:id` → "Reservation Detail").
		const parent = segs[segs.length - 2];
		if (parent && !parent.startsWith(":")) {
			return `${titleize(parent)} Detail`;
		}
		return titleize(last.slice(1));
	}
	return titleize(last);
}

function titleize(s) {
	return s
		.replace(/[-_]+/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/**
 * Pull every `route: "..."` value out of an existing snap-flows.ts. Naive
 * regex (the file is hand-curated TS, not arbitrary JS), but reliable
 * for snap-flows.ts shapes since route values are always string literals.
 */
function extractDeclaredRoutes(src) {
	const set = new Set();
	const re = /route\s*:\s*["'`]([^"'`]+)["'`]/g;
	let m;
	while ((m = re.exec(src))) {
		if (m[1]) set.add(m[1]);
	}
	return set;
}

/**
 * Insert a "Recently added" flow as the first child of the top-level
 * `flows: [ ... ]` array. Returns the patched file source. Lookup uses
 * the marker pattern `version: 1,\n\tflows: [` so we land in the right
 * array (not a nested sub-flow's `flows`). Bails — returns src unchanged —
 * if the marker isn't found, since we'd rather no-op than corrupt.
 */
function appendRecentlyAddedFlow(src, newRoutes) {
	const marker = "flows: [";
	const idx = src.indexOf(marker);
	if (idx === -1) return src;
	const insertAt = idx + marker.length;
	const insertion =
		"\n" +
		[
			"\t\t{",
			'\t\t\tid: "recently-added",',
			'\t\t\tname: "Recently added",',
			"\t\t\tscreens: [",
			...newRoutes.map((r, i) => {
				const screen = routeToScreen(r);
				const trailing = i === newRoutes.length - 1 ? "" : ",";
				return `\t\t\t\t{ route: ${JSON.stringify(screen.route)}, name: ${JSON.stringify(screen.name)} }${trailing}`;
			}),
			"\t\t\t],",
			"\t\t},",
		].join("\n");
	return src.slice(0, insertAt) + insertion + src.slice(insertAt);
}

function routeToScreen(r) {
	return { route: r.route, name: deriveScreenName(r.route) };
}

function countFlows(flows) {
	let n = 0;
	for (const f of flows) {
		n += 1;
		if (f.flows) n += countFlows(f.flows);
	}
	return n;
}

function countScreens(flows) {
	let n = 0;
	for (const f of flows) {
		n += (f.screens ?? []).length;
		if (f.flows) n += countScreens(f.flows);
	}
	return n;
}

function buildFlowNode(flowId, flowRoutes) {
	// Routes with 3+ path segments AND a 2nd-segment shared by ≥2 siblings →
	// promote that 2nd segment into a sub-flow.
	// e.g. /booking/payment/method + /booking/payment/details → "payment" sub-flow.
	const direct = [];
	const subBuckets = new Map();
	for (const r of flowRoutes) {
		const segs = r.route.split("/").filter(Boolean);
		if (segs.length <= 2 || flowId === "auth" || flowId === "main") {
			direct.push(r);
			continue;
		}
		const subKey = segs[1].replace(/^:/, "");
		const list = subBuckets.get(subKey) ?? [];
		list.push(r);
		subBuckets.set(subKey, list);
	}

	const subFlows = [];
	for (const [subKey, subRoutes] of subBuckets) {
		if (subRoutes.length >= 2) {
			subFlows.push({
				id: `${flowId}-${subKey}`,
				name: titleize(subKey),
				screens: subRoutes.map(routeToScreen),
			});
		} else {
			direct.push(...subRoutes);
		}
	}

	const node = {
		id: flowId,
		name: titleize(flowId),
		screens: direct.map(routeToScreen),
	};
	if (subFlows.length > 0) {
		node.flows = subFlows;
	}
	return node;
}

function buildDeclaration(routes) {
	const byFlow = new Map();
	for (const r of routes) {
		const flowId = topSegment(r.route);
		const list = byFlow.get(flowId) ?? [];
		list.push(r);
		byFlow.set(flowId, list);
	}

	const flows = [];
	for (const [flowId, flowRoutes] of byFlow) {
		flows.push(buildFlowNode(flowId, flowRoutes));
	}

	// Nice ordering: auth first, main second, then alphabetical.
	flows.sort((a, b) => {
		if (a.id === "auth") return -1;
		if (b.id === "auth") return 1;
		if (a.id === "main") return -1;
		if (b.id === "main") return 1;
		return a.id.localeCompare(b.id);
	});

	return { version: 1, flows };
}

function renderFlow(f, indent) {
	const inner = `${indent}\t`;
	const screens = (f.screens ?? [])
		.map(
			(s) =>
				`${inner}\t{ route: ${JSON.stringify(s.route)}, name: ${JSON.stringify(s.name)} }`,
		)
		.join(",\n");
	const subFlows = f.flows ? renderFlows(f.flows, inner) : null;
	const lines = [];
	lines.push(`${indent}{`);
	lines.push(`${inner}id: ${JSON.stringify(f.id)},`);
	lines.push(`${inner}name: ${JSON.stringify(f.name)},`);
	if (screens) {
		lines.push(`${inner}screens: [`);
		lines.push(screens);
		lines.push(`${inner}],`);
	}
	if (subFlows) {
		lines.push(`${inner}flows: [`);
		lines.push(subFlows);
		lines.push(`${inner}],`);
	}
	lines.push(`${indent}}`);
	return lines.join("\n");
}

function renderFlows(flows, indent) {
	return flows.map((f) => renderFlow(f, indent)).join(",\n");
}

function renderTs(decl) {
	const body = renderFlows(decl.flows, "\t\t");
	return `/**
 * Auto-generated by @unicorn-studio/snap-bridge's snap-flows-scan CLI.
 *
 * Re-run \`pnpm exec snap-flows-scan\` after adding/removing routes —
 * this regenerates from your app/ folder. Capture preserves your runtime
 * customizations (rename, drag-reorder, manual flow grouping) in its own
 * manifest, so regenerating here does NOT undo those.
 *
 * To refine the auto-grouping (split flows differently, add stateHash
 * filters, etc.), edit this file by hand or with Claude Code.
 */
import type { SnapFlowsDeclaration } from "@unicorn-studio/snap-bridge";

export const snapFlows: SnapFlowsDeclaration = {
\tversion: 1,
\tflows: [
${body},
\t],
};
`;
}

function printHelp() {
	console.log(`
snap-flows-scan — generate snap-flows.ts from your Expo Router app/ folder

Usage:
  pnpm exec snap-flows-scan [options]

Options:
  --app-dir <path>   Path to the app/ directory.
                     Default: auto-detected (app/, mobile/app/, apps/mobile/app/, src/app/)
  --out <path>       Path to write snap-flows.ts.
                     Default: <parent-of-app>/snap-flows.ts
  --merge, -m        ADDITIVE mode (recommended after initial setup): keeps
                     your curated snap-flows.ts intact, adds any new routes
                     under a "Recently added" flow. Stale routes are NOT
                     auto-removed — review by hand. Use without --merge to
                     regenerate from scratch (overwrites curation).
  --dry-run          Print the result without writing.
  -h, --help         Show this help.

Day-1 setup: run without flags to seed snap-flows.ts.
Day-N iteration: run with --merge after adding/removing routes; then re-run
the improver in Capture to re-group new routes into the right user-journey.
`);
}

// ════════════════════════════════════════════════════════════════════════════
// arg parsing
// ════════════════════════════════════════════════════════════════════════════
const args = argv.slice(2);
let appDirArg = null;
let outFile = null;
let dryRun = false;
let mergeMode = false;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if ((a === "--app-dir" || a === "-d") && args[i + 1]) {
		appDirArg = args[++i];
	} else if ((a === "--out" || a === "-o") && args[i + 1]) {
		outFile = args[++i];
	} else if (a === "--dry-run") {
		dryRun = true;
	} else if (a === "--merge" || a === "-m") {
		mergeMode = true;
	} else if (a === "-h" || a === "--help") {
		printHelp();
		exit(0);
	} else {
		console.error(`Unknown arg: ${a}`);
		printHelp();
		exit(1);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// locate `app/`
// ════════════════════════════════════════════════════════════════════════════
function resolveAppDir() {
	if (appDirArg) {
		const abs = resolve(appDirArg);
		if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
		console.error(`--app-dir not found: ${abs}`);
		exit(1);
	}
	for (const candidate of [
		"app",
		"mobile/app",
		"apps/mobile/app",
		"src/app",
	]) {
		const full = join(cwd(), candidate);
		if (existsSync(full) && statSync(full).isDirectory()) return full;
	}
	return null;
}

const appDir = resolveAppDir();
if (!appDir) {
	console.error(
		"Could not find an Expo Router `app/` directory. Pass --app-dir <path>.",
	);
	console.error(`Tried: app/, mobile/app/, apps/mobile/app/, src/app/`);
	exit(1);
}

const projectAppDir = relative(cwd(), appDir) || appDir;
console.log(`Scanning ${projectAppDir}/...`);

const targetTs = outFile
	? resolve(outFile)
	: join(dirname(appDir), "snap-flows.ts");

// ════════════════════════════════════════════════════════════════════════════
// walk + build
// ════════════════════════════════════════════════════════════════════════════
const routes = [];

function walk(dir, baseRel) {
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".") || entry.startsWith("_")) continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			walk(full, `${baseRel}/${entry}`);
			continue;
		}
		if (!SCREEN_EXT.test(entry)) continue;
		if (/\.(test|spec|stories|d)\./.test(entry)) continue;
		const route = fileToRoute(`${baseRel}/${entry}`);
		if (!routes.some((r) => r.route === route)) {
			routes.push({ route, file: entry, dirPath: baseRel });
		}
	}
}

walk(appDir, "");
routes.sort((a, b) => a.route.localeCompare(b.route));

if (routes.length === 0) {
	console.error("No screens found under the app dir.");
	exit(1);
}

// Merge mode is the day-2 path: keep the user's curated snap-flows.ts
// (improver-refined grouping, hand-edits, sub-flows) intact, but ADD
// any routes that exist in app/ but aren't yet declared. New routes
// land in a "Recently added" bucket at the top so they're easy to
// re-group via the next improver pass.
if (mergeMode) {
	if (!existsSync(targetTs)) {
		console.log(
			`⚠  No existing ${relative(cwd(), targetTs) || targetTs} — falling back to full generation. (use without --merge to clarify intent)`,
		);
		// Fall through to full-write path
	} else {
		const existingSrc = readFileSync(targetTs, "utf8");
		const existingRoutes = extractDeclaredRoutes(existingSrc);
		const scannedRoutes = new Set(routes.map((r) => r.route));
		const newRoutes = routes.filter((r) => !existingRoutes.has(r.route));
		const removedRoutes = [...existingRoutes].filter(
			(r) => !scannedRoutes.has(r),
		);

		if (newRoutes.length === 0 && removedRoutes.length === 0) {
			console.log(
				`✓ ${relative(cwd(), targetTs) || targetTs} already in sync — no changes.`,
			);
			exit(0);
		}

		if (dryRun) {
			console.log(`\n--- merge dry run ---`);
			if (newRoutes.length > 0) {
				console.log(`  + ${newRoutes.length} new route(s):`);
				for (const r of newRoutes) console.log(`      ${r.route}`);
			}
			if (removedRoutes.length > 0) {
				console.log(
					`  - ${removedRoutes.length} stale route(s) (still in file but not in app/):`,
				);
				for (const r of removedRoutes) console.log(`      ${r}`);
			}
			console.log(
				`\n(merge dry run — would patch existing file in place; stale routes are NOT auto-removed)`,
			);
			exit(0);
		}

		// Patch the file: insert a "Recently added" sub-flow node right
		// after the opening `flows: [` so new routes are obvious. We
		// don't touch existing entries, even if their routes disappeared
		// from app/ — those become "dangling" but stale flow pruning on
		// the desktop side handles that gracefully.
		if (newRoutes.length > 0) {
			const patched = appendRecentlyAddedFlow(existingSrc, newRoutes);
			writeFileSync(targetTs, patched);
			console.log(
				`✓ Merged ${newRoutes.length} new route${newRoutes.length === 1 ? "" : "s"} into ${relative(cwd(), targetTs) || targetTs} under "Recently added".`,
			);
			console.log(
				`  Re-run the improver (Capture's "✨ Improve" button) to fold them into the right user-journey flows.`,
			);
		}
		if (removedRoutes.length > 0) {
			console.log(
				`ℹ  ${removedRoutes.length} route${removedRoutes.length === 1 ? " is" : "s are"} still in the file but no longer in app/ — review by hand if they're truly gone:`,
			);
			for (const r of removedRoutes) console.log(`      ${r}`);
		}

		// Skip layout wiring + package script suggestions on merge — they're
		// noise once the project is past initial setup.
		exit(0);
	}
}

const decl = buildDeclaration(routes);
const tsContent = renderTs(decl);

if (dryRun) {
	console.log(`\n--- ${relative(cwd(), targetTs) || targetTs} ---\n`);
	process.stdout.write(tsContent);
	const flowCount = countFlows(decl.flows);
	const screenCount = countScreens(decl.flows);
	console.log(`\n(dry run — ${flowCount} flow(s), ${screenCount} screen(s))`);
	exit(0);
}

mkdirSync(dirname(targetTs), { recursive: true });
writeFileSync(targetTs, tsContent);

const flowCount = countFlows(decl.flows);
const screenCount = countScreens(decl.flows);
console.log(
	`✓ Wrote ${relative(cwd(), targetTs) || targetTs} — ${flowCount} flow(s), ${screenCount} screen(s)`,
);

// ── Post-scan checks: layout wiring + package.json shortcut ────────────────
checkLayoutWiring(appDir, targetTs);
suggestPackageScript(appDir);

function checkLayoutWiring(appDir, snapFlowsPath) {
	const layoutCandidates = [
		join(appDir, "_layout.tsx"),
		join(appDir, "_layout.jsx"),
		join(appDir, "_layout.ts"),
		join(appDir, "_layout.js"),
	];
	const layoutPath = layoutCandidates.find((p) => existsSync(p));
	if (!layoutPath) {
		console.log("");
		console.log(
			"⚠  No root _layout file found in app/ — make sure you're calling",
		);
		console.log("   installSnapBridge({ projectId, flows: snapFlows }) somewhere.");
		return;
	}
	const layoutSrc = readFileSyncSafe(layoutPath);
	const hasInstall = /installSnapBridge\s*\(/.test(layoutSrc);
	const hasFlows = /flows\s*:\s*snapFlows/.test(layoutSrc);
	const hasImport = /from\s+['"]\.\.?\/snap-flows['"]/.test(layoutSrc);

	console.log("");
	if (hasInstall && hasFlows && hasImport) {
		console.log(
			`✓ ${relative(cwd(), layoutPath)} is wired up — installSnapBridge({ ..., flows: snapFlows }) found.`,
		);
		return;
	}
	console.log(
		`⚠  ${relative(cwd(), layoutPath)} needs a one-time edit. Add at module scope:`,
	);
	console.log("");
	const importPath = relative(dirname(layoutPath), snapFlowsPath)
		.replace(/\.tsx?$/, "")
		.replace(/\\/g, "/");
	const importSpec = importPath.startsWith(".")
		? importPath
		: `./${importPath}`;
	console.log(`   import { installSnapBridge } from "@unicorn-studio/snap-bridge";`);
	console.log(`   import { snapFlows } from "${importSpec}";`);
	console.log("");
	console.log(`   installSnapBridge({ projectId: "<your-slug>", flows: snapFlows });`);
}

function suggestPackageScript(appDir) {
	// `mobile/package.json` lives next to `mobile/app/`. Find it.
	const pkgPath = join(dirname(appDir), "package.json");
	if (!existsSync(pkgPath)) return;
	let pkg;
	try {
		pkg = JSON.parse(readFileSyncSafe(pkgPath));
	} catch {
		return;
	}
	const scripts = pkg.scripts ?? {};
	if (scripts.flows === "snap-flows-scan") return; // already added
	console.log("");
	console.log(
		`💡 Tip — add "flows": "snap-flows-scan" to ${relative(cwd(), pkgPath)} scripts.`,
	);
	console.log(
		"   Then a route change is just: pnpm flows  (instead of pnpm exec snap-flows-scan)",
	);
}

function readFileSyncSafe(p) {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}
