import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the app under /Pulse/, set via VITE_BASE in the workflow.
export default defineConfig({ base: process.env.VITE_BASE ?? "/", plugins: [react()] });
