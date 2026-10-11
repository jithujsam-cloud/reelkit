'use client';

export function BarChart({ data }) {
  const max = Math.max(...data);
  const labels = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12'];
  return (
    <div className="bar-chart" role="img" aria-label="Weekly replies">
      {data.map((v, i) => (
        <div key={i} className="bar-col">
          <div className="bar" style={{ height: `${(v / max) * 100}%`, animationDelay: `${i * 45}ms` }} />
          <span>{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

export function LineChart({ data }) {
  const w = 520;
  const h = 180;
  const max = Math.max(...data) * 1.1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - (v / max) * h]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L${w},${h} L0,${h} Z`;
  return (
    <svg className="line-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Revenue trend">
      <defs>
        <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1="0" x2={w} y1={h * g} y2={h * g} className="grid" />
      ))}
      <path d={area} fill="url(#area)" className="area" />
      <path d={d} className="line" />
    </svg>
  );
}

export function Donut({ data }) {
  const colors = ['var(--accent)', 'var(--accent-2)', 'var(--accent-3)'];
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 42 42" className="donut" role="img" aria-label="Channel mix">
        <circle cx="21" cy="21" r="15.9" className="donut-track" />
        {data.map((c, i) => {
          const el = (
            <circle
              key={c.name}
              cx="21"
              cy="21"
              r="15.9"
              fill="none"
              stroke={colors[i]}
              strokeWidth="5"
              strokeDasharray={`${c.value} ${100 - c.value}`}
              strokeDashoffset={25 - offset}
              className="donut-seg"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          );
          offset += c.value;
          return el;
        })}
      </svg>
      <ul className="legend">
        {data.map((c, i) => (
          <li key={c.name}><i style={{ background: colors[i] }} />{c.name}<b>{c.value}%</b></li>
        ))}
      </ul>
    </div>
  );
}
