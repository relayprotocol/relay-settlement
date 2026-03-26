import type { Config } from "tailwindcss"

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Relay violet primary colors (from relay-kit)
        primary: {
          DEFAULT: "#4615C8",
          1: "#FDFDFF",
          2: "#F7F8FF",
          3: "#EFF1FF",
          4: "#E4E7FF",
          5: "#D7DBFF",
          6: "#C8CCFF",
          7: "#B4B8FF",
          8: "#989AFF",
          9: "#4615C8",
          10: "#3B00B4",
          11: "#5A45DF",
          12: "#2A226E",
          // Legacy aliases
          50: "#FDFDFF",
          100: "#F7F8FF",
          200: "#EFF1FF",
          300: "#E4E7FF",
          400: "#D7DBFF",
          500: "#5A45DF",
          600: "#4615C8",
          700: "#3B00B4",
          800: "#2A226E",
          900: "#0E0E23",
        },
        // Slate/Gray from Radix (relay-kit style)
        gray: {
          1: "#FCFCFD",
          2: "#F9F9FB",
          3: "#EFF0F3",
          4: "#E7E8EC",
          5: "#E0E1E6",
          6: "#D8D9E0",
          7: "#CDCED7",
          8: "#B9BBC6",
          9: "#8B8D98",
          10: "#80828D",
          11: "#62636C",
          12: "#1E1F24",
        },
        // Status colors
        green: {
          9: "#30A46C",
          10: "#299764",
          11: "#18794E",
        },
        amber: {
          3: "#FFF4D5",
          4: "#FFECBC",
          9: "#FFB224",
          11: "#AD5700",
        },
        red: {
          9: "#E5484D",
          10: "#DC3D43",
          11: "#CD2B31",
        },
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        heading: ["Chivo", "sans-serif"],
      },
      borderRadius: {
        widget: "16px",
        card: "12px",
        input: "8px",
        button: "12px",
      },
      boxShadow: {
        widget: "0px 4px 30px rgba(0, 0, 0, 0.10)",
        card: "0px 1px 3px rgba(0, 0, 0, 0.04), 0px 6px 16px rgba(0, 0, 0, 0.04)",
      },
    },
  },
  plugins: [],
}
export default config
