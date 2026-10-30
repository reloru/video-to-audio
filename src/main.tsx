import { render } from "preact";
import { App } from "./app/App";
import { AppStore } from "./app/store";
import "./styles.css";

// ?output=memory keeps outputs in memory instead of on-device storage (used by tests, and a
// fallback if the Origin Private File System misbehaves on some browser).
const storage = new URLSearchParams(location.search).get("output") === "memory" ? "memory" : "auto";
const store = new AppStore(storage);

render(<App store={store} />, document.getElementById("app")!);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support is optional */
    });
  });
}
