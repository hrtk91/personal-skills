import { index, route, type RouteConfig } from "@react-router/dev/routes";
export default [index("routes/home.tsx"), route("p/:name/:tab?", "routes/project.tsx")] satisfies RouteConfig;
