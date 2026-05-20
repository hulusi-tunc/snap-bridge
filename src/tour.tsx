/**
 * @unicorn-studio/snap-bridge/tour
 *
 * Tour handler — listens for `cmd:"goto"` on the bridge WebSocket, drives
 * the router, and acks with `kind:"ready"`. Implements the contract in
 * Unicorn Capture's docs/snap-tour-handler.md.
 *
 * Mount once at app root, alongside the existing snap-bridge install:
 *
 *   import { SnapTourHandler } from "@unicorn-studio/snap-bridge/tour";
 *   // (or from "@unicorn-studio/snap-bridge" — both re-exports work)
 *
 *   export default function RootLayout() {
 *     return (
 *       <>
 *         <Stack />
 *         {__DEV__ && <SnapTourHandler />}
 *       </>
 *     );
 *   }
 *
 * For screens that fetch + render before they're "done", drop a
 * `<SnapReady />` inside the loaded subtree. The handler waits for the
 * first such mount, with a 2-rAF fallback for screens that never mount one.
 *
 * Production-safe: the handler does nothing if it never receives a `goto`
 * message — and `cmd:"goto"` only comes from a locally-running Unicorn
 * Capture. Still, gate the mount with `__DEV__` per the docs; nothing in
 * this file should ship to App Store builds.
 */

import { useEffect, useRef } from "react";
import {
	getBridgeProjectId,
	sendBridgeMessage,
	subscribeBridgeMessages,
} from "./index";

// ─── Settle signal plumbing ──────────────────────────────────────────────
// `readySignal` is the in-flight goto's "screen has settled" resolver.
// It's nulled out as soon as it fires so a stale <SnapReady/> from a
// previous goto can't accidentally complete the next one.
let readySignal: (() => void) | null = null;

/**
 * Imperative form — call this hook from anywhere inside a screen and
 * the next `goto` ack will wait for the component holding this hook to
 * mount. Use the wrapper component `<SnapReady/>` for the common case;
 * use the hook directly when you want the signal tied to a specific
 * effect's deps (e.g. "fonts AND data both loaded").
 */
export function useSnapReadyHandle(): void {
	const firedRef = useRef(false);
	useEffect(() => {
		if (firedRef.current) return;
		firedRef.current = true;
		readySignal?.();
	});
}

/**
 * Drop this inside a screen's loaded-content subtree to opt that screen
 * out of the default 2-rAF settle. The handler resolves as soon as this
 * component first mounts.
 *
 *   function CompanyScreen() {
 *     const { data, isLoading } = useCompany(id);
 *     return (
 *       <>
 *         {data ? <Body data={data} /> : <Skeleton />}
 *         {!isLoading && <SnapReady />}
 *       </>
 *     );
 *   }
 */
export function SnapReady(): null {
	useSnapReadyHandle();
	return null;
}

// ─── Router lookup (expo-router only, lazy-required) ─────────────────────
// We don't `import` expo-router at the top because (a) the root barrel
// re-exports this module, and (b) we want this file to be importable in
// non-expo-router environments without exploding at parse time. The
// require fires on first goto, by which point any expo-router app has
// it loaded anyway.
type ExpoRouterModule = {
	router: {
		replace: (path: string) => void;
		navigate?: (path: string) => void;
	};
};

let cachedRouter: ExpoRouterModule["router"] | null = null;
let routerLoadFailed = false;
function getRouter(): ExpoRouterModule["router"] | null {
	if (cachedRouter) return cachedRouter;
	if (routerLoadFailed) return null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require("expo-router") as ExpoRouterModule;
		cachedRouter = mod.router;
		return cachedRouter;
	} catch {
		routerLoadFailed = true;
		return null;
	}
}

/**
 * Substitute `:foo` placeholders with `params.foo`. Mirrors the
 * tour-client's `expandRoute`; we don't share the symbol because we
 * don't want a hard dep on capture's SDK.
 */
function expandRoute(
	route: string,
	params: Record<string, string | number> | undefined,
): string {
	if (!params) return route;
	return route.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (full, name) => {
		const v = params[name];
		return v === undefined ? full : encodeURIComponent(String(v));
	});
}

// ─── Handler ─────────────────────────────────────────────────────────────

interface GotoMsg {
	cmd: "goto";
	id: string;
	route: string;
	params?: Record<string, string | number>;
}

function isGotoMsg(m: unknown): m is GotoMsg {
	if (!m || typeof m !== "object") return false;
	const o = m as { cmd?: unknown; id?: unknown; route?: unknown };
	return o.cmd === "goto" && typeof o.id === "string" && typeof o.route === "string";
}

export function SnapTourHandler(): null {
	useEffect(() => {
		const unsubscribe = subscribeBridgeMessages((msg) => {
			if (!isGotoMsg(msg)) return;
			void handleGoto(msg);
		});
		return unsubscribe;
	}, []);
	return null;
}

async function handleGoto(msg: GotoMsg): Promise<void> {
	const startedAt = Date.now();
	try {
		const router = getRouter();
		if (!router) {
			throw new Error(
				"expo-router not available — SnapTourHandler requires expo-router. " +
					"For @react-navigation/native, fork this module and swap navigateTo.",
			);
		}
		const pathname = expandRoute(msg.route, msg.params);
		router.replace(pathname);

		await waitForSettle();

		sendBridgeMessage({
			kind: "ready",
			id: msg.id,
			projectId: getBridgeProjectId(),
			route: msg.route,
			settleMs: Date.now() - startedAt,
		});
	} catch (err) {
		sendBridgeMessage({
			kind: "ready",
			id: msg.id,
			ok: false,
			error: (err as Error)?.message ?? String(err),
		});
	}
}

/**
 * Resolve when the new screen has either:
 *   (a) mounted a `<SnapReady />`, or
 *   (b) survived two `requestAnimationFrame` ticks after the navigation
 *       commit — enough time for any synchronous-rendering screen to
 *       paint its first frame.
 *
 * Whichever fires first wins. The 2-rAF fallback is what the spec calls
 * the "default settle"; <SnapReady/> overrides it for async screens.
 */
function waitForSettle(): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			readySignal = null;
			resolve();
		};
		readySignal = finish;
		// Fallback: 2 rAF ticks after the goto fires. rAF is a global in
		// React Native's runtime; if it's somehow missing (web SSR? a
		// stripped-down JS engine?) we fall back to a microtask so we
		// don't hang the goto.
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(() => {
				requestAnimationFrame(finish);
			});
		} else {
			queueMicrotask(finish);
		}
	});
}
