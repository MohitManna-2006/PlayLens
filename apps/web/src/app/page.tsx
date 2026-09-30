import { Suspense } from 'react';

async function SystemStatus() {
  let apiStatus = 'unknown';
  let dbStatus = 'unknown';
  let redisStatus = 'unknown';

  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    const res = await fetch(`${apiUrl}/api/v1/health`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      apiStatus = data.status === 'ok' ? 'Healthy' : 'Degraded';
      dbStatus = data.dependencies?.database === 'ok' ? 'Healthy' : 'Unavailable';
      redisStatus = data.dependencies?.redis === 'ok' ? 'Healthy' : 'Unavailable';
    } else {
      apiStatus = 'Unavailable';
      dbStatus = 'Unavailable';
      redisStatus = 'Unavailable';
    }
  } catch {
    apiStatus = 'Unavailable';
    dbStatus = 'Unavailable';
    redisStatus = 'Unavailable';
  }

  return (
    <div className="grid grid-cols-2 gap-4 mt-8 p-6 bg-zinc-900 rounded-lg border border-zinc-800 text-sm">
      <div className="text-zinc-400">Web</div>
      <div className="text-emerald-400">Ready</div>
      
      <div className="text-zinc-400">API</div>
      <div className={apiStatus === 'Healthy' ? 'text-emerald-400' : 'text-rose-400'}>{apiStatus}</div>
      
      <div className="text-zinc-400">Postgres</div>
      <div className={dbStatus === 'Healthy' ? 'text-emerald-400' : 'text-rose-400'}>{dbStatus}</div>
      
      <div className="text-zinc-400">Redis</div>
      <div className={redisStatus === 'Healthy' ? 'text-emerald-400' : 'text-rose-400'}>{redisStatus}</div>
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-24">
      <div className="max-w-2xl w-full">
        <h1 className="text-4xl font-bold tracking-tight mb-4">PlayLens</h1>
        <p className="text-zinc-400 mb-8">
          Phase 1 Development Stack Initialized
        </p>
        
        <div className="flex gap-4 mb-12 text-sm">
          <span className="px-3 py-1 rounded-full bg-zinc-800 text-zinc-300">Explore</span>
          <span className="px-3 py-1 rounded-full bg-zinc-800 text-zinc-300">Play</span>
          <span className="px-3 py-1 rounded-full bg-zinc-800 text-zinc-300">Compare</span>
          <span className="px-3 py-1 rounded-full bg-zinc-800 text-zinc-300">PlayLab</span>
          <span className="px-3 py-1 rounded-full bg-zinc-800 text-zinc-300">Evaluation</span>
        </div>

        <h2 className="text-xl font-semibold mb-4">System Status</h2>
        <Suspense fallback={<div className="text-zinc-500">Checking system status...</div>}>
          <SystemStatus />
        </Suspense>
      </div>
    </main>
  );
}
