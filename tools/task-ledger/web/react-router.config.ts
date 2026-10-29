import type { Config } from "@react-router/dev/config";
// The page is opened through Tailscale's HTTPS relay (https://fedora.tail907624.ts.net:10000), which hands
// requests to 127.0.0.1:8790. React Router refuses a write whose Origin differs from the address it received,
// so the relay's address has to be allowed or every form fails with 400. Add more with TASK_DASHBOARD_ORIGINS.
const origins = (process.env.TASK_DASHBOARD_ORIGINS ?? "fedora.tail907624.ts.net:10000").split(",").map((s) => s.trim()).filter(Boolean);
export default { ssr: true, allowedActionOrigins: origins } satisfies Config;
