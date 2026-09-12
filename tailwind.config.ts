import type { Config } from 'tailwindcss';

/**
 * CampusHub design system — editorial / neo-minimalist.
 *
 * Every colour is a CSS variable defined in globals.css, so light and dark are
 * one token swap rather than a `dark:` prefix on every element. Components
 * reference roles (`bg-surface`, `text-muted`) and never raw palette steps.
 *
 * Three rules that keep this from drifting back into template territory:
 *
 *  1. FIVE hues, ONE meaning each. Blue carries every interactive affordance,
 *     orange is the brand highlight, green is verified identity, yellow is
 *     action-needed, red is destructive. A colour is never used decoratively,
 *     which is what keeps five accents from reading as chaos. No gradient ever
 *     carries meaning, and no heading is a gradient.
 *  2. Borders do the work, not shadows. Hairline `1px` separators at low
 *     contrast, with shadows reserved for genuinely floating layers (menus,
 *     popovers). Big soft drop-shadows on static cards are the single most
 *     recognisable tell of a generated layout.
 *  3. A tight type scale. The display size tops out around 3.25rem, not 6rem.
 *     Oversized hero text is the other tell, and it reads worse in Azerbaijani
 *     and Russian, where strings run 15-30% longer than English.
 */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // --- surfaces -----------------------------------------------------
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          muted: 'rgb(var(--surface-muted) / <alpha-value>)',
          inset: 'rgb(var(--surface-inset) / <alpha-value>)',
        },
        // --- text ---------------------------------------------------------
        fg: {
          DEFAULT: 'rgb(var(--fg) / <alpha-value>)',
          muted: 'rgb(var(--fg-muted) / <alpha-value>)',
          subtle: 'rgb(var(--fg-subtle) / <alpha-value>)',
        },
        // --- lines --------------------------------------------------------
        edge: {
          DEFAULT: 'rgb(var(--edge) / <alpha-value>)',
          strong: 'rgb(var(--edge-strong) / <alpha-value>)',
        },
        // --- blue: every interactive affordance ---------------------------
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover) / <alpha-value>)',
          soft: 'rgb(var(--accent-soft) / <alpha-value>)',
          fg: 'rgb(var(--accent-fg) / <alpha-value>)',
        },
        /**
         * Orange: the logo's own colour.
         *
         * Separate from `accent` because it means something different. Accent
         * says "you can act on this"; brand says "this is CampusHub" - the
         * mark, and the few places the product should feel warm. Giving it a
         * status meaning as well is how a palette starts to lie.
         */
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          hover: 'rgb(var(--brand-hover) / <alpha-value>)',
          soft: 'rgb(var(--brand-soft) / <alpha-value>)',
          fg: 'rgb(var(--brand-fg) / <alpha-value>)',
        },
        // --- semantic status ----------------------------------------------
        verified: {
          DEFAULT: 'rgb(var(--verified) / <alpha-value>)',
          soft: 'rgb(var(--verified-soft) / <alpha-value>)',
          fg: 'rgb(var(--verified-fg) / <alpha-value>)',
        },
        warn: {
          DEFAULT: 'rgb(var(--warn) / <alpha-value>)',
          soft: 'rgb(var(--warn-soft) / <alpha-value>)',
          fg: 'rgb(var(--warn-fg) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          soft: 'rgb(var(--danger-soft) / <alpha-value>)',
          fg: 'rgb(var(--danger-fg) / <alpha-value>)',
        },
      },

      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      /**
       * Deliberately compressed. `display` is the largest thing on any page and
       * it is 3.25rem, not 6rem. Negative tracking on the large sizes is what
       * makes a UI look drawn rather than defaulted.
       */
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
        xs: ['0.75rem', { lineHeight: '1.125rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.5rem' }],
        md: ['0.9375rem', { lineHeight: '1.5rem' }],
        lg: ['1.0625rem', { lineHeight: '1.625rem', letterSpacing: '-0.005em' }],
        xl: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }],
        '2xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.018em' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.022em' }],
        display: ['clamp(2rem, 4.2vw, 3.25rem)', { lineHeight: '1.08', letterSpacing: '-0.03em' }],
      },

      borderRadius: {
        DEFAULT: '0.5rem',
        lg: '0.625rem',
        xl: '0.875rem',
        '2xl': '1.125rem',
      },

      /**
       * Shadows are for floating layers only. `raised` is nearly invisible on
       * purpose — it separates a menu from the page without announcing itself.
       */
      boxShadow: {
        raised: '0 1px 2px rgb(var(--shadow) / 0.06), 0 4px 12px -4px rgb(var(--shadow) / 0.10)',
        overlay: '0 4px 8px -2px rgb(var(--shadow) / 0.10), 0 16px 40px -8px rgb(var(--shadow) / 0.22)',
        focus: '0 0 0 3px rgb(var(--accent) / 0.28)',
      },

      maxWidth: {
        prose: '42rem',
        feed: '35rem',
        shell: '76rem',
      },

      transitionTimingFunction: {
        out: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },

      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        rise: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
        shimmer: { to: { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out both',
        rise: 'rise 300ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'scale-in': 'scale-in 140ms cubic-bezier(0.22, 1, 0.36, 1) both',
        marquee: 'marquee 48s linear infinite',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
