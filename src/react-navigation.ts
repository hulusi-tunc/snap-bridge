/**
 * @unicorn-studio/snap-bridge/react-navigation
 *
 * Drop-in hook that wires React Navigation's container state into the
 * snap-bridge — no manual `setSnapState` calls needed in the host app.
 * Subscribes to the navigation container's `"state"` event and pushes the
 * focused route path / params to the bridge whenever they change.
 *
 * React Navigation has no single nav hook the way Expo Router does — global
 * nav state is read off the container ref. So unlike the expo-router adapter,
 * this one takes the ref you already pass to `<NavigationContainer>`:
 *
 *   import { createNavigationContainerRef } from "@react-navigation/native";
 *   import { installSnapBridge } from "@unicorn-studio/snap-bridge";
 *   import { useSnapAutoSync } from "@unicorn-studio/snap-bridge/react-navigation";
 *   import { snapFlows } from "./snap-flows";
 *
 *   const navigationRef = createNavigationContainerRef();
 *   installSnapBridge({ projectId: "ffie", flows: snapFlows });
 *
 *   export default function App() {
 *     useSnapAutoSync(navigationRef);          // ← that's it
 *     return (
 *       <NavigationContainer ref={navigationRef}>
 *         ...your navigators...
 *       </NavigationContainer>
 *     );
 *   }
 *
 * If you don't keep a ref, spread the handler onto the container instead:
 *
 *   <NavigationContainer {...snapNavObserver()}>
 *
 * For app-level dimensions the bridge can't auto-detect (user role,
 * subscription plan, A/B test variant), pair this with `setSnapStateContext`
 * from your main entry point — see its JSDoc for an example. Apps with
 * home-rolled navigation (custom tab state, phase machines) that don't mount
 * a NavigationContainer should call `setSnapState` directly from their nav
 * source instead — this adapter only observes React Navigation containers.
 *
 * Production-safe: `setSnapState` no-ops outside __DEV__ via the bridge's own
 * dev-gating; the hook itself does no harm in prod.
 */

import { useEffect } from "react";
import { setSnapState } from "./index";

/**
 * A React Navigation route node. Mirrors the shape of `Route` /
 * `NavigationState` from `@react-navigation/native` (v6 + v7) without
 * importing it — keeps this adapter a zero-dependency, structurally-typed
 * layer the same way the core stays framework-agnostic.
 */
interface NavRoute {
	name: string;
	// React Navigation types params as `Readonly<object | undefined>`, so this
	// must be `object` (not `Record<string, unknown>`, which would demand an
	// index signature the RN type doesn't have). normalizeParams re-narrows it.
	params?: object;
	/** Present when this route hosts a nested navigator. */
	state?: NavStateLike;
}

interface NavStateLike {
	/** Index of the focused route within `routes`. */
	index?: number;
	routes: NavRoute[];
}

/**
 * The subset of the React Navigation container ref this adapter uses. Both
 * `createNavigationContainerRef()` and `useNavigationContainerRef()` return
 * an object satisfying this.
 */
export interface SnapNavigationRef {
	isReady?: () => boolean;
	getRootState?: () => NavStateLike | undefined;
	addListener?: (type: "state", callback: () => void) => (() => void) | void;
}

/**
 * Hook — call once where you create the navigation container ref. Subscribes
 * to the container's `"state"` event and pushes the focused route path into
 * the bridge on every change. Safe everywhere: a missing/not-yet-ready ref is
 * a no-op, and `setSnapState` is itself dev-gated.
 */
export function useSnapAutoSync(ref: SnapNavigationRef | null | undefined): void {
	useEffect(() => {
		if (!ref || typeof ref.addListener !== "function") return;

		const sync = () => {
			// `addListener("state")` can fire once before the container reports
			// ready (during the initial mount); skip until the tree is real.
			if (typeof ref.isReady === "function" && !ref.isReady()) return;
			const rootState = ref.getRootState?.();
			if (!rootState) return;
			const { path, stack, params } = describeState(rootState);
			setSnapState({
				route: path,
				// React Navigation route names ARE the stable pattern — there are
				// no URL-style dynamic segments in the name path, so params live
				// in `extras` and the literal path doubles as the pattern. This
				// lets Capture collapse e.g. every DocDetail into one flow while
				// the id stays available for debugging.
				routePattern: path,
				navStack: stack,
				extras: { params },
			});
		};

		// Fire once now in case the container is already mounted + ready (e.g.
		// the hook is added after navigation settled, or under hot-reload).
		sync();
		const unsub = ref.addListener("state", sync);
		return () => {
			if (typeof unsub === "function") unsub();
		};
	}, [ref]);
}

/**
 * Non-hook alternative for apps that don't keep a container ref. Spread the
 * result onto `<NavigationContainer {...snapNavObserver()} />`; the
 * `onStateChange` it returns pushes the focused route to the bridge on every
 * navigation change. React Navigation hands `onStateChange` the root state
 * directly, so no ref is needed.
 *
 * If the container already has its own `onStateChange`, call this from inside
 * yours rather than spreading (a spread would overwrite one of them).
 */
export function snapNavObserver(): {
	onStateChange: (state: NavStateLike | undefined) => void;
} {
	return {
		onStateChange: (state) => {
			if (!state) return;
			const { path, stack, params } = describeState(state);
			setSnapState({
				route: path,
				routePattern: path,
				navStack: stack,
				extras: { params },
			});
		},
	};
}

/**
 * Walk a React Navigation state tree from the root to the focused leaf,
 * collecting the nested route names into a `/Tabs/News/Article`-style path.
 * Params returned are the focused leaf's params (the most specific), since
 * that's the screen actually on display.
 *
 * Examples:
 *   Tabs(News) → News(Article{id})   → path "/Tabs/News/Article", params {id}
 *   single Home screen                → path "/Home"
 *   empty / malformed state           → path "/"
 */
function describeState(state: NavStateLike): {
	path: string;
	stack: string[];
	params: Record<string, string>;
} {
	const stack: string[] = [];
	let cursor: NavStateLike | undefined = state;
	let leafParams: object | undefined;
	// Guard against pathological/cyclic state with a hard depth cap.
	for (let depth = 0; cursor && depth < 32; depth++) {
		// Pin the current node to a typed local — `cursor` is reassigned to
		// `route.state` below, which would otherwise make `idx`'s inference
		// circular (idx ← cursor ← route ← idx) and trip noImplicitAny.
		const node: NavStateLike = cursor;
		const idx: number =
			typeof node.index === "number" ? node.index : node.routes.length - 1;
		const route: NavRoute | undefined = node.routes?.[idx];
		if (!route) break;
		stack.push(route.name);
		leafParams = route.params;
		cursor = route.state;
	}
	return {
		path: stack.length === 0 ? "/" : `/${stack.join("/")}`,
		stack,
		params: normalizeParams(leafParams),
	};
}

/**
 * Flatten route params into string values for `extras`. Nested objects /
 * arrays are JSON-stringified; functions and undefined are dropped. Mirrors
 * the expo-router adapter's `normalizeParams` so both feed Capture the same
 * shape.
 */
function normalizeParams(raw: object | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!raw) return out;
	for (const [k, v] of Object.entries(raw)) {
		if (v === undefined || typeof v === "function") continue;
		out[k] =
			typeof v === "object" ? safeStringify(v) : String(v as string | number | boolean);
	}
	return out;
}

function safeStringify(v: unknown): string {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}
