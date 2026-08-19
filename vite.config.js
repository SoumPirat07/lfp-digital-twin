import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Set the base to your GitHub repository name: '/<repo-name>/'
export default defineConfig({
  plugins: [react()],
  base: './', // Using './' ensures relative paths work out of the box on GitHub Pages
})