import type { Metadata } from "next"
import { Inter, Chivo } from "next/font/google"
import dynamic from "next/dynamic"
import "./globals.css"
import { ToastContainer } from "@/components/Toast"

const Providers = dynamic(
  () => import("./providers").then((m) => m.Providers),
  {
    ssr: false,
  }
)

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
})

const chivo = Chivo({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-chivo",
})

export const metadata: Metadata = {
  title: "Withdraw | Relay",
  description: "Relay Protocol Withdrawal UI",
  icons: {
    icon: "/relay-logo.svg",
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${inter.variable} ${chivo.variable}`}>
      <body className="font-sans bg-neutral-50 text-neutral-900 antialiased min-h-screen">
        <Providers>{children}</Providers>
        <ToastContainer />
      </body>
    </html>
  )
}
