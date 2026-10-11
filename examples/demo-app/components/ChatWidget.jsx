'use client';
// A fake third-party chat launcher that bobs forever (an infinite animation that
// should never end up in a screenshot).
export default function ChatWidget() {
  return (
    <button className="chat-widget" aria-label="Open chat">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
}
