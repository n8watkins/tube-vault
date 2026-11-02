import React from 'react';

// Thin progress bar for a running download. With an unknown total it slides
// (keyframes `tv-indeterminate` live in popup.html and options.html).
export function ProgressBar({ percent, marginTop = 7 }: { percent: number | null; marginTop?: number }) {
  return (
    <div
      style={{ ...track, marginTop }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      {percent === null
        ? <div style={indeterminate} data-indeterminate="" />
        : <div style={{ ...fill, width: `${Math.max(2, percent)}%` }} />}
    </div>
  );
}

const track: React.CSSProperties = { position: 'relative', height: 4, borderRadius: 2, background: '#2c2c2c', overflow: 'hidden' };
const fill: React.CSSProperties = { height: '100%', borderRadius: 2, background: '#42a5f5', transition: 'width 0.6s ease' };
const indeterminate: React.CSSProperties = {
  position: 'absolute', top: 0, height: '100%', width: '30%', borderRadius: 2, background: '#42a5f5',
  animation: 'tv-indeterminate 1.4s ease-in-out infinite',
};
