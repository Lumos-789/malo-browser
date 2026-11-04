import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createMockApi } from "./mock-api";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Director 渲染失败：找不到 #root 容器");

const api = window.demoStage ?? createMockApi();
const mock = !window.demoStage;
if (mock) console.info("[director] window.demoStage 不可用，使用 mock 数据预览");

createRoot(container).render(
  <StrictMode>
    <App api={api} mock={mock} />
  </StrictMode>,
);
