'use client';
import { useEffect, useState } from 'react';

// Deliberately annoying: slides in after a short delay, like real consent banners.
export default function CookieBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (document.cookie.includes('consent=1')) return;
    const t = setTimeout(() => setShow(true), 400);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div id="cookie-banner" className="cookie-banner" role="dialog" aria-label="Cookie consent">
      <p>We use cookies to improve your experience. By continuing you agree to our cookie policy.</p>
      <div className="cookie-actions">
        <button className="btn btn-ghost" onClick={() => setShow(false)}>Decline</button>
        <button
          className="btn btn-primary"
          onClick={() => {
            document.cookie = 'consent=1; path=/; max-age=31536000';
            setShow(false);
          }}
        >
          Accept all
        </button>
      </div>
    </div>
  );
}
