import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Stream Selector Assessment',
    template: '%s | Stream Selector',
  },
  description:
    'A psychometric guidance platform for students in Grades 8 to 12. Reports describe how a student answered, not what they are capable of becoming.',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#172554',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.variable}>{children}</body>
    </html>
  );
}
