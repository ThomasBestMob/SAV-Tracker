/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Fraunces"', 'Georgia', 'serif'],
        sans: ['"Inter"', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"IBM Plex Mono"', 'monospace'],
      },
      colors: {
        ink: '#0a0a0a',
        paper: '#fafaf7',
        accent: '#1d5fae',   // bleu opérationnel (distinct du rouge brique de Veille Digitale)
        urgent: '#c8401c',   // réservé aux alertes/priorité haute
        muted: '#6b6863',
        rule: '#1a1a1a',
        warm: '#eef1f5',
      },
      letterSpacing: {
        wider: '0.08em',
        widest: '0.18em',
      },
    },
  },
  plugins: [],
};
