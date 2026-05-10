/**
 * @unicorn-studio/snap-bridge
 *
 * Tiny dev-only bridge between a running RN app and the Unicorn Capture
 * desktop tool. Opens a WebSocket to ws://localhost:<port> on app start,
 * replies to {cmd:"get-state"} with the latest snapshot the host app has
 * pushed via setSnapState().
 *
 * Framework-agnostic: it doesn't import expo-router or react-navigation.
 * The host app calls setSnapState() whenever its nav state changes.
 *
 * Production-safe: the bridge no-ops outside __DEV__.
 */

export interface SnapState {
	/** Current route, e.g. "/booking/select-court" */
	route: string;
	/** Stack of route names from root to current, e.g. ["(tabs)", "profile"] */
	navStack?: string[];
	/** Hash of relevant runtime state (form values, list lengths, error flags). */
	stateHash?: string;
	/** Free-form key→value runtime state for debugging / future use. */
	extras?: Record<string, unknown>;
}

/**
 * One screen in a declared flow. Capture matches incoming snaps to a
 * declared screen by `route`, then auto-places them in the right flow
 * with the right name, no manual drag needed.
 */
export interface FlowScreen {
	/** Stable id for this screen. Defaults to a slug of `route` if omitted. */
	id?: string;
	/** Human-readable name shown in the gallery. Defaults to derived-from-route. */
	name?: string;
	/**
	 * Route pattern. Supports `:param` for dynamic segments — e.g.
	 * `/reservation/:id` matches `/reservation/abc123`. Use `*` only at
	 * the end to match any tail.
	 */
	route: string;
	/**
	 * Optional state-hash filter. When set, only snaps with this exact
	 * stateHash place into this screen — lets you split scroll positions
	 * or popup states into distinct expected screens.
	 */
	stateHash?: string;
}

/**
 * A flow as declared by the host app. Mirrors capture's data model:
 * id + name + nested sub-flows. Order in `flows` arrays = display order.
 */
export interface FlowNode {
	id: string;
	/** Display name. Defaults to a title-cased version of `id`. */
	name?: string;
	/** Screens that belong to this flow, in capture order. */
	screens?: FlowScreen[];
	/** Nested sub-flows. Recursive — depth is unlimited. */
	flows?: FlowNode[];
}

/**
 * The full flow declaration the host app provides. Capture uses this to:
 *   - Pre-render placeholder cards for expected screens
 *   - Auto-place snaps into the right flow on capture
 *   - Show progress (N of M screens captured)
 *
 * Generate by hand or via a tool that scans your router config (`app/`
 * for Expo Router). User overrides (manual rename, drag) take priority
 * — re-declaring with new content won't clobber edits the user made.
 */
export interface SnapFlowsDeclaration {
	version: 1;
	flows: FlowNode[];
}

export interface InstallOptions {
	projectId: string;
	/** Default 9876. Change only if the desktop tool is configured to listen elsewhere. */
	port?: number;
	/** Default "localhost". On a physical device, set to the host Mac's LAN IP. */
	host?: string;
	/** Default 3000ms. How often to retry connection when the desktop tool is offline. */
	reconnectMs?: number;
	/** Optional logger. Defaults to console.log with a [snap-bridge] prefix. */
	log?: (msg: string) => void;
	/**
	 * Optional declarative flow structure. When provided, capture pre-builds
	 * the flow tree + placeholder cards so you can see what's expected
	 * before snapping anything. Snaps auto-place by route match.
	 */
	flows?: SnapFlowsDeclaration;
}

interface InternalState {
	options: {
		projectId: string;
		port: number;
		host: string;
		reconnectMs: number;
		log: (msg: string) => void;
		flows: SnapFlowsDeclaration | null;
	};
	socket: WebSocket | null;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	snapshot: SnapState;
	installed: boolean;
	/**
	 * The current screen's scrollable view ref, set by `registerSnapTarget`.
	 * Used by `react-native-view-shot` to capture beyond the viewport so
	 * the desktop tool sees the full page (including off-screen content).
	 */
	captureTarget: { current: unknown } | null;
	/**
	 * App-level context dimensions (role, plan, A/B variant). These feed
	 * into the auto-derived stateHash so the same route can split into
	 * distinct screen slots — e.g. "/home" with role=worker vs role=company.
	 * Set via `setSnapStateContext`. Survives across nav changes; cleared
	 * only by passing the same key with `null`/`undefined`.
	 */
	context: Record<string, string>;
	/**
	 * Did the host app set `stateHash` directly via setSnapState? When
	 * true, we keep that value verbatim and don't auto-derive. Lets users
	 * opt out of context-based hashing on a per-snapshot basis.
	 */
	stateHashLocked: boolean;
}

const internal: InternalState = {
	options: {
		projectId: "",
		port: 9876,
		host: "localhost",
		reconnectMs: 3000,
		log: (m) => console.log(`[snap-bridge] ${m}`),
		flows: null,
	},
	socket: null,
	reconnectTimer: null,
	snapshot: { route: "/" },
	installed: false,
	captureTarget: null,
	context: {},
	stateHashLocked: false,
};

const isDev = (): boolean => {
	if (typeof __DEV__ !== "undefined") return __DEV__;
	if (typeof process !== "undefined" && process.env?.NODE_ENV) {
		return process.env.NODE_ENV !== "production";
	}
	return false;
};

/**
 * Push the latest nav/state snapshot. Cheap to call — stash, no I/O.
 * Call it from your nav listener (expo-router useSegments / react-navigation
 * onStateChange / etc.).
 *
 * If `stateHash` is included in the patch, it locks the snapshot to that
 * exact value — auto-derived context is ignored until you call
 * `setSnapState({ stateHash: undefined })` to release the lock.
 */
export function setSnapState(patch: Partial<SnapState>): void {
	if ("stateHash" in patch) {
		if (patch.stateHash === undefined) {
			internal.stateHashLocked = false;
		} else {
			internal.stateHashLocked = true;
		}
	}
	internal.snapshot = { ...internal.snapshot, ...patch };
}

/**
 * Register or update app-level context dimensions that feed into the
 * auto-derived stateHash. Use this for state that the bridge can't
 * detect on its own — user role, subscription plan, A/B test variant,
 * feature-flag state. Same route + different context = different
 * screen slot in Capture (e.g. snap-flows can declare two `/home`
 * variants with `stateHash: "role=worker"` vs `"role=company"`).
 *
 * Pass `null` or `undefined` for a value to clear that key.
 *
 * @example
 * ```ts
 * useEffect(() => {
 *   setSnapStateContext({ role: session.role, plan: session.plan });
 * }, [session.role, session.plan]);
 * ```
 */
export function setSnapStateContext(
	patch: Record<string, string | null | undefined>,
): void {
	for (const [k, v] of Object.entries(patch)) {
		if (v === null || v === undefined || v === "") {
			delete internal.context[k];
		} else {
			internal.context[k] = String(v);
		}
	}
}

/**
 * Compose a deterministic stateHash string from the current context map.
 * Sorted by key, joined `key=value&key=value` — same shape that improver-
 * generated `stateHash` filters in snap-flows.ts use, so they line up.
 * Empty context produces "" (no filter).
 */
function deriveStateHash(): string {
	const keys = Object.keys(internal.context).sort();
	if (keys.length === 0) return "";
	return keys.map((k) => `${k}=${internal.context[k]}`).join("&");
}

/**
 * Register the current screen's scrollable view ref so the desktop tool
 * can capture the FULL page (off-screen content too), not just the
 * visible viewport. Call on mount, pass `null` on unmount.
 *
 * @example
 * ```tsx
 * function MyScreen() {
 *   const ref = useRef(null);
 *   useEffect(() => {
 *     registerSnapTarget(ref);
 *     return () => registerSnapTarget(null);
 *   }, []);
 *   return <ScrollView ref={ref}>{children}</ScrollView>;
 * }
 * ```
 *
 * Requires `react-native-view-shot` to be installed in the host app.
 */
export function registerSnapTarget<T>(
	ref: { current: T | null } | null,
): void {
	internal.captureTarget = ref as { current: unknown } | null;
}

/**
 * Open a long-lived WebSocket to the Unicorn Capture desktop tool.
 * Auto-reconnects on disconnect. No-ops in production builds.
 *
 * Idempotent under Metro hot-reload: when called a second time (because
 * the host module re-evaluated after editing snap-flows.ts) we DON'T
 * re-open the socket — we just replace `internal.options.flows` with
 * the new declaration and re-send the hello frame over the existing
 * connection. Capture's `ingestDeclaration` is upsert + prune, so the
 * sidebar updates without an iOS-sim Cmd+R.
 *
 * If projectId/host/port changes between calls, that's the only case
 * where we tear down and reconnect — those are connection-level keys.
 */
export function installSnapBridge(opts: InstallOptions): void {
	if (!isDev()) return;
	if (typeof WebSocket === "undefined") {
		console.warn("[snap-bridge] WebSocket is not available; aborting.");
		return;
	}
	const port = opts.port ?? 9876;
	const host = opts.host ?? "localhost";

	if (internal.installed) {
		const connectionChanged =
			internal.options.projectId !== opts.projectId ||
			internal.options.host !== host ||
			internal.options.port !== port;
		if (connectionChanged) {
			internal.options.log(
				`installSnapBridge: connection params changed (was ${internal.options.projectId}@${internal.options.host}:${internal.options.port}, now ${opts.projectId}@${host}:${port}). Reconnecting.`,
			);
			if (internal.socket) {
				try {
					internal.socket.close();
				} catch {}
				internal.socket = null;
			}
			internal.installed = false;
			// fall through to fresh install below
		} else {
			// Hot-reload path: same connection, possibly fresh flows. Update
			// internal state and re-send hello so Capture re-ingests.
			const flowsChanged =
				JSON.stringify(internal.options.flows ?? null) !==
				JSON.stringify(opts.flows ?? null);
			internal.options.flows = opts.flows ?? null;
			if (opts.log) internal.options.log = opts.log;
			if (typeof opts.reconnectMs === "number") {
				internal.options.reconnectMs = opts.reconnectMs;
			}
			if (flowsChanged) {
				const flowCount = opts.flows?.flows.length ?? 0;
				internal.options.log(
					`flows updated (${flowCount} top-level flow${flowCount === 1 ? "" : "s"}) — re-emitting hello`,
				);
				rehello();
			}
			return;
		}
	}

	internal.options = {
		projectId: opts.projectId,
		port,
		host,
		reconnectMs: opts.reconnectMs ?? 3000,
		log: opts.log ?? ((m) => console.log(`[snap-bridge] ${m}`)),
		flows: opts.flows ?? null,
	};
	internal.installed = true;
	connect();
}

function connect(): void {
	const { host, port, reconnectMs, log } = internal.options;
	const url = `ws://${host}:${port}`;
	let ws: WebSocket;
	try {
		ws = new WebSocket(url);
	} catch (err) {
		log(`failed to construct WebSocket: ${(err as Error).message}`);
		scheduleReconnect();
		return;
	}
	internal.socket = ws;

	ws.onopen = () => {
		log(`connected to ${url}`);
		send({
			kind: "hello",
			projectId: internal.options.projectId,
			pid: typeof process !== "undefined" ? process.pid : undefined,
			flows: internal.options.flows ?? undefined,
		});
	};

	ws.onmessage = (event) => {
		let msg: unknown;
		try {
			msg =
				typeof event.data === "string"
					? JSON.parse(event.data)
					: event.data;
		} catch {
			log("ignoring non-JSON message");
			return;
		}
		if (
			!msg ||
			typeof msg !== "object" ||
			!("cmd" in msg) ||
			typeof (msg as { cmd: unknown }).cmd !== "string"
		) {
			return;
		}
		const cmd = (msg as { cmd: string }).cmd;
		const id =
			"id" in msg && typeof (msg as { id?: unknown }).id === "string"
				? (msg as { id: string }).id
				: undefined;
		if (cmd === "get-state") {
			// Compose final snapshot: if the host hasn't explicitly set a
			// stateHash via setSnapState, fold in the auto-derived hash from
			// the context map. This lets improver-generated `role=worker`
			// filters Just Work without manual string-building per screen.
			const liveSnapshot: SnapState = internal.stateHashLocked
				? internal.snapshot
				: { ...internal.snapshot, stateHash: deriveStateHash() };
			send({
				kind: "state",
				id,
				projectId: internal.options.projectId,
				snapshot: liveSnapshot,
				ts: Date.now(),
			});
		} else if (cmd === "ping") {
			send({ kind: "pong", id, ts: Date.now() });
		} else if (cmd === "capture-full-page") {
			void handleCaptureFullPage(id);
		}
	};

	ws.onerror = () => {
		// Errors fire before close; let close handle reconnect.
	};

	ws.onclose = () => {
		log("disconnected");
		internal.socket = null;
		scheduleReconnect();
	};

	void reconnectMs; // referenced via scheduleReconnect
}

/**
 * Re-send the hello frame over the existing socket. Used after a hot-reload
 * `installSnapBridge` call: the connection is fine, we just want Capture to
 * re-ingest the (possibly updated) flow declaration. If the socket isn't
 * open yet — e.g. we got hot-reloaded between connect() and onopen — the
 * fresh flows still go out as part of the queued onopen handler since it
 * reads `internal.options.flows` at fire time.
 */
function rehello(): void {
	const ws = internal.socket;
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	try {
		ws.send(
			JSON.stringify({
				kind: "hello",
				projectId: internal.options.projectId,
				pid: typeof process !== "undefined" ? process.pid : undefined,
				flows: internal.options.flows ?? undefined,
			}),
		);
	} catch (err) {
		internal.options.log(`rehello failed: ${(err as Error).message}`);
	}
}

function scheduleReconnect(): void {
	if (internal.reconnectTimer) return;
	internal.reconnectTimer = setTimeout(() => {
		internal.reconnectTimer = null;
		if (internal.installed) connect();
	}, internal.options.reconnectMs);
}

/**
 * Capture the registered SnapTarget as a base64 PNG and reply over WS.
 * Uses `react-native-view-shot` (lazily required so the bridge stays
 * installable without it — full-page just won't work). For ScrollView
 * refs, view-shot captures the entire content size, not just the
 * visible viewport.
 */
async function handleCaptureFullPage(id: string | undefined): Promise<void> {
	if (!internal.captureTarget?.current) {
		send({
			kind: "capture",
			id,
			ok: false,
			error:
				"No SnapTarget registered — call registerSnapTarget(scrollViewRef) on mount.",
		});
		return;
	}
	let viewShot: { captureRef: (...args: unknown[]) => Promise<string> };
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		viewShot = require("react-native-view-shot");
	} catch {
		send({
			kind: "capture",
			id,
			ok: false,
			error:
				"react-native-view-shot not installed. Run: npm install react-native-view-shot && npx pod-install",
		});
		return;
	}
	try {
		// The host app must register a regular View ref that wraps the
		// scroll content (NOT the ScrollView itself). On Fabric the
		// `snapshotContentContainer` option errors out on RCTScrollView,
		// but captureRef on a plain View returns its full layout-rect —
		// including content outside the scroll viewport. See the
		// `useSnapTarget` hook README for the recommended pattern:
		//   <ScrollView><View ref={snapRef}>{content}</View></ScrollView>
		const base64 = await viewShot.captureRef(
			internal.captureTarget as unknown,
			{ format: "png", result: "base64", quality: 1 },
		);
		send({ kind: "capture", id, ok: true, image: base64 });
	} catch (err) {
		send({
			kind: "capture",
			id,
			ok: false,
			error: (err as Error)?.message ?? String(err),
		});
	}
}

function send(payload: Record<string, unknown>): void {
	const ws = internal.socket;
	if (!ws || ws.readyState !== 1) return; // 1 = OPEN
	try {
		ws.send(JSON.stringify(payload));
	} catch (err) {
		internal.options.log(`send failed: ${(err as Error).message}`);
	}
}

/**
 * Tear down the bridge. Useful for hot-reload scenarios. Optional —
 * most apps install once and never uninstall.
 */
export function uninstallSnapBridge(): void {
	internal.installed = false;
	if (internal.reconnectTimer) {
		clearTimeout(internal.reconnectTimer);
		internal.reconnectTimer = null;
	}
	if (internal.socket) {
		try {
			internal.socket.close();
		} catch {
			// ignore
		}
		internal.socket = null;
	}
}

/** Read the current snapshot. Mostly for tests. */
export function getCurrentSnapshot(): SnapState {
	return internal.snapshot;
}

declare const __DEV__: boolean | undefined;
