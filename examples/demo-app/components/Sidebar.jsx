'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Logo from './Logo';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: 'M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z' },
  { href: '/campaigns', label: 'Campaigns', icon: 'M4 4h16v12H5.17L4 17.17zm0-2a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z' },
];

export default function Sidebar() {
  const path = usePathname();
  return (
    <aside className="sidebar">
      <Logo />
      <nav>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? 'active' : ''}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={n.icon} /></svg>
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
      <div className="sidebar-user">
        <div className="avatar">JR</div>
        <div>
          <div className="user-name">Jordan Rivera</div>
          <div className="user-email">jordan.rivera@acme-corp.com</div>
        </div>
      </div>
    </aside>
  );
}
