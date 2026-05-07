# @unicorn-studio/snap-bridge

Tiny dev-only RN package that exposes a running app's nav state to the [Unicorn Capture](../capture/) desktop tool over a WebSocket.

No native modules. Framework-agnostic — works with expo-router, react-navigation, or any other routing setup. Production-safe (no-ops outside `__DEV__`).

## Install

In the customer app (e.g. an Expo monorepo):

```bash
npm install --save-dev "file:../path/to/snap-bridge"
```

(Or workspace alias if both projects are in a monorepo. Eventually published to GitHub Packages.)

## Use (expo-router example)

In your root layout file (`app/_layout.tsx`):

```ts
import { useEffect } from "react";
import { useSegments, usePathname } from "expo-router";
import { installSnapBridge, setSnapState } from "@unicorn-studio/snap-bridge";

// One-time install. Safe in production — no-ops outside __DEV__.
installSnapBridge({ projectId: "folleli" });

export default function RootLayout() {
  const segments = useSegments();
  const pathname = usePathname();

  useEffect(() => {
    setSnapState({
      route: pathname,
      navStack: segments,
    });
  }, [pathname, segments]);

  return /* ... your existing layout ... */;
}
```

That's it. The desktop tool will see the route as you navigate.

## Use (react-navigation example)

```ts
import { NavigationContainer, useNavigationContainerRef } from "@react-navigation/native";
import { installSnapBridge, setSnapState } from "@unicorn-studio/snap-bridge";

installSnapBridge({ projectId: "your-project" });

export function App() {
  const ref = useNavigationContainerRef();
  return (
    <NavigationContainer
      ref={ref}
      onStateChange={() => {
        const route = ref.getCurrentRoute();
        if (!route) return;
        setSnapState({
          route: "/" + route.name,
          navStack: ref.getRootState()?.routes.map((r) => r.name) ?? [],
        });
      }}
    >
      {/* ... */}
    </NavigationContainer>
  );
}
```

## On a physical device

The default `host` is `localhost`. For a physical iPhone connected to the same Wi-Fi as your Mac:

```ts
installSnapBridge({
  projectId: "folleli",
  host: "192.168.1.42", // your Mac's LAN IP
});
```

## Connection lifecycle

- Bridge connects to `ws://localhost:9876` on app start.
- If the Unicorn Capture desktop tool isn't running, bridge silently retries every 3 seconds.
- When the tool starts, bridge auto-reconnects.
- Bridge sends `{kind:"hello", projectId}` on connect.
- Tool sends `{cmd:"get-state", id}` to request a snap snapshot; bridge replies with `{kind:"state", id, snapshot}`.

## Why this design

- **Tiny:** ~150 LoC, zero native modules, zero opinions about your nav library.
- **Decoupled:** customer app pushes state on its schedule; tool pulls on demand.
- **Production-safe:** dev-only by default — bundled in releases is fine, code self-disables.
- **Bidirectional:** future commands beyond `get-state` (e.g. trigger error overlays, dump component tree) can be added as new `cmd` values.

## State hashing (future)

For now, only `route` and `navStack` are auto-pushed. The optional `stateHash` field is intended for hashing form values / list lengths / error flags — so re-snapping the same screen in different states produces different versions in the gallery. Today, customer code can compute and push it manually:

```ts
setSnapState({
  route: pathname,
  stateHash: form.hasError ? "error" : form.values.email ? "filled" : "empty",
});
```

A future helper will derive this from React DevTools / component-tree introspection automatically.
