import { index, route, type RouteConfig } from "@react-router/dev/routes";
export default [
  index("routes/home.tsx"),
  route("p/:name", "routes/turn.tsx"),
  route("p/:name/epic", "routes/epic-list.tsx"),
  route("p/:name/epic/:goalId", "routes/epic-stage.tsx"),
  route("p/:name/task/:taskId", "routes/task.tsx"),
  route("p/:name/values", "routes/values.tsx"),
  route("p/:name/:old", "routes/legacy.tsx"),
] satisfies RouteConfig;
