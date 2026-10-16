import { AsyncPanel } from "./async-panel";

const deployments = [
  { name: "api-gateway", env: "production", status: "live" as const },
  { name: "web-frontend", env: "staging", status: "building" as const },
  { name: "billing-worker", env: "production", status: "failed" as const },
];

export default {
  name: "AsyncPanel",
  component: AsyncPanel,
  states: {
    loading: { isLoading: true },
    error: { error: "GET /api/deployments returned 503" },
    success: { deployments },
    empty: { deployments: [] },
  },
  background: { light: "#f8f9fb", dark: "#0c0e12" },
};
