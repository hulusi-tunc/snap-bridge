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
 */
export function setSnapState(patch: Partial<SnapState>): void {
	internal.snapshot = { ...internal.snapshot, ...patch };
}

/**
 * Open a long-lived WebSocket to the Unicorn Capture desktop tool.
 * Auto-reconnects on disconnect. No-ops in production builds.
 */
export function installSnapBridge(opts: InstallOptions): void {
	if (!isDev()) return;
	if (internal.installed) {
		internal.options.log(
			"installSnapBridge called twice — ignoring second call.",
		);
		return;
	}
	if (typeof WebSocket === "undefined") {
		console.warn("[snap-bridge] WebSocket is not available; aborting.");
		return;
	}
	internal.options = {
		projectId: opts.projectId,
		port: opts.port ?? 9876,
		host: opts.host ?? "localhost",
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
			send({
				kind: "state",
				id,
				projectId: internal.options.projectId,
				snapshot: internal.snapshot,
				ts: Date.now(),
			});
		} else if (cmd === "ping") {
			send({ kind: "pong", id, ts: Date.now() });
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

function scheduleReconnect(): void {
	if (internal.reconnectTimer) return;
	internal.reconnectTimer = setTimeout(() => {
		internal.reconnectTimer = null;
		if (internal.installed) connect();
	}, internal.options.reconnectMs);
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
