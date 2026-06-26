import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'Kanika Designs — Admin',
  description: 'WhatsApp order automation dashboard',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Kanika Designs',
    statusBarStyle: 'default',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  );
}
