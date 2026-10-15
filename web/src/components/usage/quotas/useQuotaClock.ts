import { useEffect, useState } from 'react';

// One display clock per page. Ticking never collects or reloads quota data.
export function useQuotaClock(clockOffset = 0) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now + clockOffset;
}
