import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [reactRouter()], server: { fs: { allow: [process.cwd(), '/home/h-taminato/repos/random-image-genarator/node_modules'] } } });
