#!/usr/bin/env node
/**
 * snap-bridge wrap-screen / unwrap-screen
 *
 * Surgical, per-screen tool that adds the `<View ref={useSnapTarget()}
 * collapsable={false}>` wrap around a ScrollView's content so the bridge's
 * full-page capture path can include off-screen content. Used when one
 * specific screen (typically a long Home or feed) needs longer-than-viewport
 * snaps, without touching the other 39 screens in the app.
 *
 * The wrap is bracketed by marker comments so `unwrap-screen` can find it
 * later and remove it cleanly. A `.snap-bridge.bak` backup is also written
 * before any edit, in case the wrap subtly breaks layout and the user
 * wants to revert by hand.
 *
 * Usage:
 *   pnpm exec snap-bridge-wrap-screen /home
 *   pnpm exec snap-bridge-wrap-screen /home --dry-run
 *   pnpm exec snap-bridge-wrap-screen /home --unwrap
 *   pnpm exec snap-bridge-wrap-screen --list   # show wrappable screens
 *
 * Bails gracefully (with manual instructions) when the file is structured
 * in ways the regex can't handle safely (zero or multiple ScrollViews, no
 * default export, etc.).
 */
import {
	copyFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { argv, cwd, exit } from "node:process";

const SCREEN_EXT = /\.(tsx|ts|jsx|js)$/;
// JSX comments must be wrapped in curly braces — bare `/* */` inside JSX
// children renders as a literal string and crashes RN with "Text strings
// must be rendered within a <Text> component" (ovria + folleli home.tsx
// both hit this). Keep the braces in the marker string itself so the
// unwrap regex below still matches deterministically.
const MARK_OPEN = "{/* @snap-target — wrap added by snap-bridge wrap-screen */}";
const MARK_CLOSE = "{/* @snap-target end */}";

// ─── helpers shared with snap-flows-scan ──────────────────────────────────
function fileToRoute(relPath) {
	let r = relPath
		.replace(SCREEN_EXT, "")
		.replace(/\.(ios|android|native|web)$/, "")
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

function resolveAppDir(arg) {
	if (arg) {
		const abs = resolve(arg);
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

function walk(dir, baseRel, out) {
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".") || entry.startsWith("_")) continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			walk(full, `${baseRel}/${entry}`, out);
			continue;
		}
		if (!SCREEN_EXT.test(entry)) continue;
		if (/\.(test|spec|stories|d)\./.test(entry)) continue;
		out.push({ route: fileToRoute(`${baseRel}/${entry}`), file: full });
	}
}

// ─── arg parsing ──────────────────────────────────────────────────────────
const args = argv.slice(2);
let appDirArg = null;
let route = null;
let unwrap = false;
let dryRun = false;
let listMode = false;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if ((a === "--app-dir" || a === "-d") && args[i + 1]) {
		appDirArg = args[++i];
	} else if (a === "--unwrap") {
		unwrap = true;
	} else if (a === "--dry-run") {
		dryRun = true;
	} else if (a === "--list") {
		listMode = true;
	} else if (a === "-h" || a === "--help") {
		printHelp();
		exit(0);
	} else if (!route && !a.startsWith("-")) {
		route = a;
	} else {
		console.error(`Unknown arg: ${a}`);
		printHelp();
		exit(1);
	}
}

function printHelp() {
	console.log(`
snap-bridge wrap-screen — enable full-page capture for one screen at a time

Usage:
  snap-bridge-wrap-screen <route>             Wrap the screen's ScrollView
  snap-bridge-wrap-screen <route> --unwrap    Remove a previous wrap
  snap-bridge-wrap-screen --list              List candidate screens
  snap-bridge-wrap-screen <route> --dry-run   Preview without writing

Examples:
  snap-bridge-wrap-screen /home
  snap-bridge-wrap-screen /profile/personal-info --unwrap

Routes use the same syntax as snap-flows.ts (e.g. "/home" or
"/profile/personal-info" or "/reservation/:id"). Auto-detects the app/ dir.

Wrap is bracketed by marker comments + a .snap-bridge.bak backup is
written so undoing is safe even if the regex got something wrong.
`);
}

const appDir = resolveAppDir(appDirArg);
if (!appDir) {
	console.error(
		"Could not find an Expo Router app/ directory. Pass --app-dir <path>.",
	);
	exit(1);
}

const screens = [];
walk(appDir, "", screens);

if (listMode) {
	console.log(`Candidate screens (${screens.length}):`);
	for (const s of screens.sort((a, b) => a.route.localeCompare(b.route))) {
		const wrapped = readFileSafe(s.file).includes(MARK_OPEN) ? " ✓ wrapped" : "";
		console.log(`  ${s.route.padEnd(40)} ${relative(cwd(), s.file)}${wrapped}`);
	}
	exit(0);
}

if (!route) {
	console.error("Missing route. Try `snap-bridge-wrap-screen --list`.");
	exit(1);
}

const target = screens.find((s) => s.route === route);
if (!target) {
	console.error(`No screen matches route "${route}".`);
	console.error("Did you mean one of these?");
	const close = closestRoutes(route, screens.map((s) => s.route));
	for (const r of close) console.error(`   ${r}`);
	exit(1);
}

const src = readFileSync(target.file, "utf8");
const filePath = relative(cwd(), target.file);
const alreadyWrapped = src.includes(MARK_OPEN);

if (unwrap) {
	if (!alreadyWrapped) {
		console.log(`✓ ${filePath} doesn't have a snap-target wrap — nothing to undo.`);
		exit(0);
	}
	const result = removeWrap(src);
	if (!result.ok) {
		console.error(`Couldn't undo wrap: ${result.reason}`);
		console.error(`Try restoring from ${target.file}.snap-bridge.bak by hand.`);
		exit(1);
	}
	if (dryRun) {
		console.log(`(dry run) Would remove wrap from ${filePath}.`);
		exit(0);
	}
	writeFileSync(target.file, result.src);
	console.log(`✓ Removed snap-target wrap from ${filePath}.`);
	exit(0);
}

if (alreadyWrapped) {
	console.log(`✓ ${filePath} already has a snap-target wrap. Use --unwrap to remove it.`);
	exit(0);
}

const wrap = addWrap(src);
if (!wrap.ok) {
	console.error(`✗ Can't auto-wrap ${filePath}:`);
	console.error(`  ${wrap.reason}`);
	console.error("");
	console.error("Manual fix — wrap your screen's ScrollView like this:");
	console.error("");
	console.error(`  import { useSnapTarget } from '../hooks/useSnapTarget';`);
	console.error("  // …");
	console.error(`  const snapRef = useSnapTarget();`);
	console.error(`  return (`);
	console.error(`    <ScrollView>`);
	console.error(`      ${MARK_OPEN}`);
	console.error(`      <View ref={snapRef} collapsable={false}>`);
	console.error(`        {/* your existing content */}`);
	console.error(`      </View>`);
	console.error(`      ${MARK_CLOSE}`);
	console.error(`    </ScrollView>`);
	console.error(`  );`);
	exit(1);
}

if (dryRun) {
	console.log(`(dry run) Would write ${filePath} with snap-target wrap. Diff hint:`);
	console.log("  • adds `import { useSnapTarget } from '<rel>/hooks/useSnapTarget'`");
	console.log("  • adds `const __snapRef = useSnapTarget()` inside the component body");
	console.log("  • wraps ScrollView content in `<View ref={__snapRef} collapsable={false}>`");
	console.log("  • brackets with marker comments + writes .snap-bridge.bak");
	exit(0);
}

// Backup before edit. snap-bridge-setup uses the same .bak naming convention.
copyFileSync(target.file, `${target.file}.snap-bridge.bak`);
writeFileSync(target.file, wrap.src);
console.log(`✓ Wrapped ${filePath} for full-page capture.`);
console.log(`  Backup: ${filePath}.snap-bridge.bak`);
console.log(`  If this breaks layout, run: snap-bridge wrap-screen ${route} --unwrap`);

// ─── wrap / unwrap mechanics ──────────────────────────────────────────────
function addWrap(src) {
	// Step 1: locate the ScrollView. We require exactly one — bail if
	// there's a nested ScrollView or if it's not present at all.
	const openMatches = [...src.matchAll(/<ScrollView\b([^>]*)>/g)];
	if (openMatches.length === 0) {
		return { ok: false, reason: "no <ScrollView> found in this screen" };
	}
	if (openMatches.length > 1) {
		return {
			ok: false,
			reason: `${openMatches.length} <ScrollView> tags in this screen — ambiguous which one to wrap`,
		};
	}
	const openMatch = openMatches[0];
	const openStart = openMatch.index;
	const openEnd = openStart + openMatch[0].length;
	const closeRe = /<\/ScrollView\s*>/g;
	closeRe.lastIndex = openEnd;
	const closeMatch = closeRe.exec(src);
	if (!closeMatch) {
		return { ok: false, reason: "no matching </ScrollView> tag" };
	}
	const closeStart = closeMatch.index;

	// Step 2: ensure View is imported from react-native (it usually is).
	let next = src;
	if (!/from\s+['"]react-native['"]/.test(next)) {
		return {
			ok: false,
			reason: "no `from 'react-native'` import — can't add `View` automatically",
		};
	}
	if (!/\bView\b[^;]*from\s+['"]react-native['"]/.test(next)) {
		next = next.replace(
			/import\s*\{\s*([^}]+?)\s*\}\s*from\s*(['"]react-native['"])/,
			(_match, names, q) => {
				const list = names.split(",").map((s) => s.trim()).filter(Boolean);
				if (!list.includes("View")) list.push("View");
				return `import { ${list.join(", ")} } from ${q}`;
			},
		);
	}

	// Step 3: add the useSnapTarget import. Path is relative to the
	// screen's file; assume the hook lives at <rnAppDir>/hooks/useSnapTarget
	// (snap-bridge-setup writes it there by default).
	const hookImportPath = computeHookImportPath(target.file);
	const hookImport = `import { useSnapTarget } from "${hookImportPath}";`;
	if (!next.includes("useSnapTarget")) {
		// Insert after the last existing import to keep the import block tidy.
		const lastImport = lastImportEnd(next);
		next =
			next.slice(0, lastImport) + `\n${hookImport}` + next.slice(lastImport);
	}

	// Step 4: drop a `const __snapRef = useSnapTarget();` inside the
	// default-exported component body, just below the opening brace.
	const exportRe =
		/export\s+default\s+function\s+\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/;
	const expMatch = exportRe.exec(next);
	if (!expMatch) {
		return {
			ok: false,
			reason: "couldn't locate `export default function ...() {` to inject the hook call",
		};
	}
	const inject = "\n  // @snap-target — bridge full-page capture target\n  const __snapRef = useSnapTarget();\n";
	const fnBraceEnd = expMatch.index + expMatch[0].length;
	next =
		next.slice(0, fnBraceEnd) + inject + next.slice(fnBraceEnd);

	// Step 5: wrap the ScrollView's content with a View ref + marker
	// comments. Indices on `next` shift relative to `src` because of the
	// imports/hook injection above; recompute.
	const newOpenMatch = /<ScrollView\b([^>]*)>/.exec(next);
	if (!newOpenMatch) {
		return { ok: false, reason: "lost ScrollView during pre-edit" };
	}
	const newOpenEnd = newOpenMatch.index + newOpenMatch[0].length;
	const newCloseRe = /<\/ScrollView\s*>/g;
	newCloseRe.lastIndex = newOpenEnd;
	const newCloseMatch = newCloseRe.exec(next);
	if (!newCloseMatch) {
		return { ok: false, reason: "lost </ScrollView> during pre-edit" };
	}
	const newCloseStart = newCloseMatch.index;

	const inner = next.slice(newOpenEnd, newCloseStart);
	const wrapped =
		"\n      " + MARK_OPEN +
		"\n      <View ref={__snapRef} collapsable={false}>" +
		inner.replace(/\n/g, "\n  ") +
		"</View>" +
		"\n      " + MARK_CLOSE + "\n    ";
	next = next.slice(0, newOpenEnd) + wrapped + next.slice(newCloseStart);
	void closeStart;
	void openMatch;

	return { ok: true, src: next };
}

function removeWrap(src) {
	// Strip the View wrap block + the marker comments. The fastest, safest
	// pass is a single regex with the markers as anchors so we don't depend
	// on the exact indentation we wrote.
	// Accept both the legacy bare-comment form `/* … */` and the corrected
	// JSX-comment form `{/* … */}` so projects wrapped by older CLI
	// versions still unwrap cleanly when they bump.
	const re = /\s*\{?\/\*\s*@snap-target[^*]*\*\/\}?\s*<View\s+ref=\{__snapRef\}\s+collapsable=\{false\}>([\s\S]*?)<\/View>\s*\{?\/\*\s*@snap-target end\s*\*\/\}?/;
	const m = src.match(re);
	if (!m) {
		return { ok: false, reason: "wrap markers not found in their expected shape" };
	}
	let next = src.replace(re, m[1]);
	// Also remove the hook injection + import (best-effort; if the user
	// has come to rely on useSnapTarget elsewhere, leave them alone).
	next = next.replace(
		/\n\s*\/\/\s*@snap-target[^\n]*\n\s*const\s+__snapRef\s*=\s*useSnapTarget\(\);\s*\n/,
		"\n",
	);
	if (!next.includes("__snapRef") && !next.includes("useSnapTarget(")) {
		next = next.replace(
			/^\s*import\s*\{\s*useSnapTarget\s*\}\s*from\s*['"][^'"]+['"]\s*;?\s*$/gm,
			"",
		);
	}
	return { ok: true, src: next };
}

function lastImportEnd(src) {
	const re = /^import [^;]+;[ \t]*$/gm;
	let last = 0;
	for (const m of src.matchAll(re)) {
		if (m.index === undefined) continue;
		last = m.index + m[0].length;
	}
	return last;
}

function computeHookImportPath(screenFile) {
	// Walk up from the screen file looking for hooks/useSnapTarget.{ts,tsx}.
	// Then build a relative path like "../hooks/useSnapTarget" or
	// "../../hooks/useSnapTarget".
	let dir = dirname(screenFile);
	for (let i = 0; i < 6; i++) {
		const candidates = [
			join(dir, "hooks", "useSnapTarget.ts"),
			join(dir, "hooks", "useSnapTarget.tsx"),
		];
		for (const c of candidates) {
			if (existsSync(c)) {
				let rel = relative(dirname(screenFile), c).replace(/\.tsx?$/, "");
				rel = rel.replace(/\\/g, "/");
				if (!rel.startsWith(".")) rel = `./${rel}`;
				return rel;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Fallback — assume the conventional location two levels up.
	return "../hooks/useSnapTarget";
}

function readFileSafe(p) {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

function closestRoutes(query, routes) {
	const qSegs = query.split("/").filter(Boolean);
	return routes
		.map((r) => {
			const rSegs = r.split("/").filter(Boolean);
			let score = 0;
			for (let i = 0; i < Math.min(qSegs.length, rSegs.length); i++) {
				if (qSegs[i] === rSegs[i]) score += 2;
				else if (qSegs[i] && rSegs[i]?.startsWith(qSegs[i])) score += 1;
			}
			return { r, score };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 5)
		.map((x) => x.r);
}
