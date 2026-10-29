import "./theme.css";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
export function links() { return [{ rel: "preconnect", href: "https://fonts.googleapis.com" }, { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" as const }, { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@400;500;600;700&display=swap" }]; }
export function Layout({ children }: { children: React.ReactNode }) { return <html lang="ja"><head><meta charSet="utf-8"/><Meta/><Links/><title>task-ledger</title></head><body>{children}<ScrollRestoration/><Scripts/></body></html>; }
export default function App() { return <Outlet/>; }
