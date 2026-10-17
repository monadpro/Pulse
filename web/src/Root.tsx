import { useEffect, useState } from "react";
import { App } from "./App";
import { Landing } from "./Landing";

const route = () => (location.hash.startsWith("#/app") ? "app" : "home");

/** Hash routing keeps GitHub Pages happy: a refresh never asks the server for a path that does not exist. */
export function Root() {
  const [r, setR] = useState(route());
  useEffect(() => {
    const on = () => setR(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r === "app" ? <App /> : <Landing />;
}
