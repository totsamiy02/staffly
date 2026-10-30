import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devApiProxy } from './scripts/dev-api-proxy.ts'
export default defineConfig({
  plugins: [react(), devApiProxy()],
  build: {
    manifest: true,
    rolldownOptions: {
      output: {
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            // Charts are used by the optional PowerPoint viewer. Keep them out
            // of route chunks and split the large vendor graph by module size.
            { name: 'presentation-charts', test: /node_modules\/(echarts|zrender)\//, maxSize: 1_000_000 },
          ],
        },
      },
    },
  },
  server: {
    strictPort: true,
    watch: { ignored: ['**/artifacts/**', '**/storage/**', '**/docs/**', '**/src/server/**', '**/src/generated/**'] },
  },
})
