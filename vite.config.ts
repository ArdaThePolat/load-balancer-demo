import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

declare const process: { env: { GITHUB_ACTIONS?: string } }

export default defineConfig({
  // This repository is deployed at /load-balancer-demo/ on GitHub Pages.
  base: process.env.GITHUB_ACTIONS ? '/load-balancer-demo/' : '/',
  plugins: [react()],
})
