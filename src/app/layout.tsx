import type { Metadata } from "next";
import { Cinzel, IBM_Plex_Mono, Noto_Serif_Ethiopic } from "next/font/google";
import "./globals.css";

const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

const notoEthiopic = Noto_Serif_Ethiopic({
  variable: "--font-noto-serif-ethiopic",
  weight: ["400", "700"],
  subsets: ["ethiopic"],
});

export const metadata: Metadata = {
  title: "GeezTranscribe",
  description: "Ethiopic PDF Transcription Tool",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${cinzel.variable} ${ibmPlexMono.variable} ${notoEthiopic.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-mono bg-bg-primary text-text-primary">
        {children}
      </body>
    </html>
  );
}
