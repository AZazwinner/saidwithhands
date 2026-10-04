import type { Metadata, Viewport } from "next";
import { GFS_Didot } from "next/font/google";
import "./globals.css";
import NavBar from "@/components/NavBar";
import Footer from "@/components/Footer";

// GFS Didot (Greek Font Society, OFL): a Didot revival hosted on Google Fonts, so every device gets the
// same face. It ships a single weight.
const didot = GFS_Didot({
  variable: "--font-didot",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "Said With Hands: sign recognizer & communication aid",
  description:
    "A communication aid for Deaf and hard-of-hearing people: recognizes ASL fingerspelling and signs you teach it, on your device, and speaks the transcript.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0a09" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${didot.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <NavBar />
        {children}
        <Footer />
      </body>
    </html>
  );
}
