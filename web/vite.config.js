import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Served from https://minidebrid.du.ranchchoco.boo/ (GitHub Pages custom domain) ; relative paths keep
// the same build working under https://meitogi.github.io/minidebrid/ too (the page is always at the
// app's root : routing lives in the fragment).
export default defineConfig({
  base: './',
  plugins: [svelte()],
});
