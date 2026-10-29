import { useLoaderData } from "react-router";
import type { Route } from "./+types/home.js";
import { getLedger } from "../ledger.server.js";
import { projects } from "../goal-tab/server.js";
export function loader(_:Route.LoaderArgs){return {projects:projects(getLedger())};}
export default function Home(){const {projects}=useLoaderData<typeof loader>();return <main style={{maxWidth:720,margin:'3rem auto',padding:'0 1rem'}}><h1>仕事の台帳</h1><ul>{projects.map(p=><li key={p.repo}><a href={`/p/${encodeURIComponent(p.name)}`}>{p.name}</a> — 判断待ち {p.waiting} / 動いている {p.running}</li>)}</ul></main>;}
