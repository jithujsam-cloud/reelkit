import './globals.css';
import CookieBanner from '../components/CookieBanner';
import ChatWidget from '../components/ChatWidget';

export const metadata = {
  title: 'Pulse: outbound analytics',
  description: 'reelkit demo app',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <CookieBanner />
        <ChatWidget />
      </body>
    </html>
  );
}
