import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// "@/..." points at frontend/src, so imports do not need long "../../" paths.
// In development the dev server forwards /api to the backend (port 3000, or JIO_BACKEND_URL). The browser then
// only talks to the page's own address, so the planner works the same on a laptop and in a codespace, where
// the page opens at a forwarded address and the browser cannot reach the codespace's localhost:3000.
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': { target: process.env.JIO_BACKEND_URL || 'http://localhost:3000', changeOrigin: true },
    },
  },
  // The tests run in Node, which compiles components for the server. A test that renders a component with its own tiny
  // stand-in for the page (src/lib/__tests__/miniDom.js) needs them compiled for the browser, so it is listed here.
  test: { testTransformMode: { web: ['**/spotsScreen.test.js', '**/confirmBusy.test.js', '**/roamScreen.test.js', '**/roamLocationSheet.test.js', '**/suggestionReview.test.js', '**/suggestionCard.test.js', '**/weatherScreen.test.js', '**/weatherDayScreen.test.js', '**/homeRain.test.js', '**/rainMaps.test.js', '**/bannerAndFieldRoles.test.js', '**/toastMessage.test.js'] } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
