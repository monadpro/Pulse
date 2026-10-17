import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./Root";
import { applyTheme, getTheme } from "./theme";
import "./style.css";

// A render error must never leave a blank black page: show the message and a reload button instead.
class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app">
        <h1>Pulse</h1>
        <div className="warn">
          页面出错了：{this.state.error.message}
          <br />
          如果浏览器开启了网页翻译（地址栏有翻译图标），请关闭翻译后刷新。
        </div>
        <p>
          <button onClick={() => location.reload()}>刷新页面</button>
        </p>
      </div>
    );
  }
}

applyTheme(getTheme());
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <Root />
  </ErrorBoundary>,
);
