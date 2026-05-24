/**
 * @unicorn-studio/snap-bridge/expo-router
 *
 * Drop-in hook that wires Expo Router's navigation primitives into the
 * snap-bridge — no manual `setSnapState` calls needed in the host app.
 * Reads `usePathname`, `useSegments`, and `useLocalSearchParams` and
 * pushes them to the bridge whenever they change.
 *
 * Usage in your root `_layout.tsx`:
 *
 *   import { installSnapBridge } from "@unicorn-studio/snap-bridge";
 *   import { useSnapAutoSync } from "@unicorn-studio/snap-bridge/expo-router";
 *   import { snapFlows } from "../snap-flows";
 *
 *   installSnapBridge({ projectId: "ovria", flows: snapFlows });
 *
 *   export default function RootLayout() {
 *     useSnapAutoSync();      // ← that's it
 *     // …rest of your layout
 *   }
 *
 * For app-level dimensions the bridge can't auto-detect (user role,
 * subscription plan, A/B test variant), pair this with `setSnapStateContext`
 * from the main entry point — see its JSDoc for an example.
 *
 * Production-safe: this module no-ops outside __DEV__ via the bridge's
 * own dev-gating; the hook itself does no harm in prod.
 */

import { useEffect } from "react";
import { setSnapState } from "./index";

// Lazy-load the expo-router hooks. They're a peer dep, not a hard one,
// so we only import them when the host app actually has expo-router
// installed (which is the only environment this file matters in).
type LazyExpoRouter = {
	usePathname: () => string;
	useSegments: () => string[];
	useLocalSearchParams: () => Record<string, string | string[] | undefined>;
};

let lazyLoaded: LazyExpoRouter | null = null;
let lazyLoadFailed = false;

function getExpoRouter(): LazyExpoRouter | null {
	if (lazyLoaded) return lazyLoaded;
	if (lazyLoadFailed) return null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require("expo-router") as LazyExpoRouter;
		lazyLoaded = {
			usePathname: mod.usePathname,
			useSegments: mod.useSegments,
			useLocalSearchParams: mod.useLocalSearchParams,
		};
		return lazyLoaded;
	} catch {
		lazyLoadFailed = true;
		return null;
	}
}

/**
 * Hook — call once in your root layout. Subscribes to Expo Router's
 * pathname/segments/params and pushes them into the bridge whenever
 * they change. Safe to use everywhere; outside dev or without
 * expo-router installed, it's a no-op.
 */
export function useSnapAutoSync(): void {
	const er = getExpoRouter();
	// Always call the same hooks unconditionally to satisfy React's hook
	// rules. When expo-router isn't available (lib not installed, web
	// build, tests), we fall through with sensible defaults.
	const pathname = er ? er.usePathname() : "";
	const segments = er ? er.useSegments() : [];
	const params = er ? er.useLocalSearchParams() : {};

	useEffect(() => {
		if (!er) return;
		setSnapState({
			route: pathname || "/",
			routePattern: segmentsToPattern(segments),
			navStack: segments,
			extras: { params: normalizeParams(params) },
		});
	}, [er, pathname, JSON.stringify(segments), JSON.stringify(params)]);
}

function normalizeParams(
	raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (v === undefined) continue;
		out[k] = Array.isArray(v) ? v.join(",") : String(v);
	}
	return out;
}

/**
 * Translate Expo Router's file-segment list into the `:param` pattern
 * syntax that Capture's snap-flows declarations already use. Strips
 * route groups (`(tabs)`) since they don't appear in the URL, and
 * converts file-based dynamic segments (`[id]`, `[...slug]`, `[[id]]`)
 * to `:id`. Returns `/` for an empty/root segment list.
 *
 * Examples:
 *   ["reservation", "[id]"]          → "/reservation/:id"
 *   ["(tabs)", "profile"]            → "/profile"
 *   ["docs", "[...slug]"]            → "/docs/:slug"
 *   []                               → "/"
 */
function segmentsToPattern(segments: string[]): string {
	const out: string[] = [];
	for (const seg of segments) {
		if (!seg) continue;
		if (seg.startsWith("(") && seg.endsWith(")")) continue; // route group
		let cleaned = seg;
		// Strip outer optional brackets: [[id]] → [id]
		if (cleaned.startsWith("[[") && cleaned.endsWith("]]")) {
			cleaned = cleaned.slice(1, -1);
		}
		if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
			const inner = cleaned.slice(1, -1).replace(/^\.\.\./, "");
			out.push(`:${inner}`);
		} else {
			out.push(cleaned);
		}
	}
	return out.length === 0 ? "/" : `/${out.join("/")}`;
}
