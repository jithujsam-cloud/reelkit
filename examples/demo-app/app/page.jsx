import Link from 'next/link';
import Logo from '../components/Logo';

const FEATURES = [
  { title: 'Sequences that adapt', body: 'Branching follow-ups that react to opens, replies and meetings in real time.' },
  { title: 'Every channel, one inbox', body: 'Email, LinkedIn and calls land in a single prioritised queue.' },
  { title: 'Analytics you can trust', body: 'Attribution down to the sentence that booked the meeting.' },
];

export default function Landing() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <Logo />
        <nav>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <Link className="btn btn-ghost" href="/login">Sign in</Link>
        </nav>
      </header>
      <section className="hero">
        <span className="pill fade-up" style={{ animationDelay: '0ms' }}>New · AI reply drafts</span>
        <h1 className="fade-up" style={{ animationDelay: '80ms' }}>
          Outbound that <span className="gradient-text">books meetings</span>, not just sends emails.
        </h1>
        <p className="lead fade-up" style={{ animationDelay: '160ms' }}>
          Pulse turns your campaigns into a live pipeline: sequences, replies and revenue in one calm dashboard.
        </p>
        <div className="hero-cta fade-up" style={{ animationDelay: '240ms' }}>
          <Link className="btn btn-primary btn-lg" href="/login">Start free trial</Link>
          <a className="btn btn-ghost btn-lg" href="#features">See how it works</a>
        </div>
        <div className="hero-card fade-up" style={{ animationDelay: '320ms' }}>
          <div className="hero-metric"><strong>3.4×</strong><span>more replies</span></div>
          <div className="hero-metric"><strong>41%</strong><span>less busywork</span></div>
          <div className="hero-metric"><strong>12k</strong><span>teams</span></div>
        </div>
      </section>
      <section id="features" className="features">
        {FEATURES.map((f, i) => (
          <article key={f.title} className="feature fade-up" style={{ animationDelay: `${400 + i * 80}ms` }}>
            <div className="feature-icon">{i + 1}</div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </article>
        ))}
      </section>
      <section id="pricing" className="features">
        <article className="feature"><h3>Starter</h3><p className="price">$29<small>/mo</small></p><p>One seat, unlimited sequences.</p></article>
        <article className="feature feature-accent"><h3>Team</h3><p className="price">$99<small>/mo</small></p><p>Five seats, shared inbox, analytics.</p></article>
        <article className="feature"><h3>Scale</h3><p className="price">Custom</p><p>SSO, audit log, dedicated support.</p></article>
      </section>
      <footer className="landing-footer">© 2026 Pulse Labs · A demo app for reelkit</footer>
    </div>
  );
}
