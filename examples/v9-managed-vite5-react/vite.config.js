import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { resolve } from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@prantlf/storycap', 
        replacement: resolve(import.meta.dirname, 'node_modules', '@prantlf', 'storycap', 'lib')
      }
    ]
  },
})
