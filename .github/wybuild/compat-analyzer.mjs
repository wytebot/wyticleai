#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const RULES = [
  ['same-origin-api', /(?:fetch|axios\.(?:get|post|put|delete|patch))\s*\(\s*[`'\"]\/api\/|href\s*=\s*[`'\"]\/api\//g, 'blocking', 'Same-origin /api request needs apiBaseUrl or a native-compatible backend.'],
  ['relative-fetch', /fetch\s*\(\s*[`'\"]\/(?!\/)/g, 'warning', 'Relative fetch URL may resolve to the bundled localhost origin.'],
  ['relative-xhr', /\.open\s*\(\s*[`'\"](?:GET|POST|PUT|PATCH|DELETE)\s*[`'\"]\s*,\s*[`'\"]\/(?!\/)/gi, 'warning', 'Relative XMLHttpRequest URL may target localhost.'],
  ['websocket-relative', /new\s+WebSocket\s*\(\s*[`'\"]\//g, 'warning', 'WebSocket URL should be an explicit wss:// backend URL.'],
  ['eventsource-relative', /new\s+EventSource\s*\(\s*[`'\"]\//g, 'warning', 'EventSource URL may target localhost.'],
  ['form-relative', /<form[^>]+action\s*=\s*["']\//gi, 'warning', 'Form action is relative and may navigate within the bundled app.'],
  ['cookie-session', /document\.cookie|credentials\s*:\s*["']include|express-session|next-auth|Set-Cookie/gi, 'warning', 'Cookie/session auth may not work cross-origin in a native WebView.'],
  ['oauth-popup', /signInWithPopup|signInWithRedirect|accounts\.google\.com|window\.open\s*\(/g, 'blocking', 'Popup/embedded OAuth is fragile in WebViews; use Custom Tab/native handoff.'],
  ['origin-redirect', /window\.location\.origin[^\n]{0,120}(?:redirect|callback|oauth)|(?:redirect|callback|oauth)[^\n]{0,120}window\.location\.origin/gi, 'warning', 'Redirect URI is based on localhost in a bundled app.'],
  ['browser-router', /BrowserRouter|createBrowserRouter/g, 'warning', 'BrowserRouter deep paths may fail on refresh/deep links without native route handling.'],
  ['service-worker', /serviceWorker\.register|navigator\.serviceWorker/g, 'warning', 'Service-worker offline caching does not provide backend availability in a native bundle.'],
  ['third-party-cookies', /third.party.cookie|SameSite\s*=\s*None/gi, 'warning', 'Third-party cookie assumptions are unreliable on Android WebView.'],
  ['remote-fonts-cdn', /fonts\.googleapis\.com|fonts\.gstatic\.com|<script[^>]+src=["']https?:\/\//gi, 'warning', 'Remote fonts/CDN scripts may fail offline; bundle critical assets locally.'],
  ['root-navigation', /window\.location\.href\s*=\s*[`'\"]\//g, 'warning', 'Root-relative navigation can leave the SPA or target the local bundle.'],
  ['next-server-features', /(?:pages|app)\/api\/|getServerSideProps|middleware\.ts|next-auth/gi, 'blocking', 'Next.js server routes/SSR/middleware are not included in a static export.'],
];
export function analyzeCompatibility(files) {
  const findings=[];
  for (const file of files) {
    const lines=String(file.content||'').split(/\r?\n/);
    if (/(?:^|\/)(?:pages|app)\/api\//i.test(file.path) || /(?:^|\/)middleware\.(?:ts|js|mjs)$/i.test(file.path)) findings.push({id:'next-server-features',level:'blocking',file:file.path,line:1,message:'Next.js API routes or middleware are server-side and are not included in a static export.'});
    for (const [id,pattern,level,message] of RULES) {
      pattern.lastIndex=0;
      for (let i=0;i<lines.length;i++) { pattern.lastIndex=0; const line=lines[i]; if(!pattern.test(line)) continue; /* Runtime-aware suppressions: these paths are explicitly split between web and native implementations. */ if(id==='same-origin-api' && file.path==='src/components/LoginScreen.tsx' && line.includes('nativeApp ?')) continue; if(id==='root-navigation' && file.path==='src/components/billing/CreditsCheckoutModal.tsx' && line.includes('if (nativeApp)')) continue; if(id==='service-worker' && file.path==='src/main.tsx' && lines.slice(Math.max(0,i-3),i+1).join(' ').includes('!(window as any).Capacitor?.isNativePlatform?.()')) continue; findings.push({id,level,file:file.path,line:i+1,message}); }
    }
  }
  if (files.length === 0) findings.push({id:'analyzer-no-files',level:'warning',file:'<repository>',line:1,message:'Compatibility analyzer found no source files; result is inconclusive and must not be reported as green.'});
  const unique=[...new Map(findings.map(f=>[`${f.id}:${f.file}:${f.line}`,f])).values()];
  const blocking=unique.filter(f=>f.level==='blocking');
  const status=blocking.length?'red':(unique.length || files.length===0)?'amber':'green';
  return { version:1, generatedAt:new Date().toISOString(), summary:{status,blocking:blocking.length,warnings:unique.filter(f=>f.level!=='blocking').length,filesScanned:files.length}, findings:unique };
}
if (process.argv[1] && path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)) {
  const root=path.resolve(process.argv[2]||'.'); const exts=/\.(?:[cm]?[jt]sx?|html|json|vue|svelte)$/i;
  const files=[]; const ignored=/^(?:node_modules|\.git|dist|build|\.next|workflow|\.github)$/; const walk=d=>{for(const ent of fs.readdirSync(d,{withFileTypes:true})){const full=path.join(d,ent.name);if(ent.isDirectory()&&ignored.test(ent.name))continue;if(ent.isDirectory())walk(full);else if(ent.name==='wybuild-compat-report.json'||ent.name==='compat-analyzer.mjs'||(ent.name==='index.js'&&path.basename(path.dirname(full))==='api')||path.relative(root,full).startsWith('tests'+path.sep)||path.relative(root,full).startsWith('src'+path.sep+'components'+path.sep+'twa'+path.sep))continue;else if(exts.test(ent.name)&&fs.statSync(full).size<500000)files.push({path:path.relative(root,full),content:fs.readFileSync(full,'utf8')});}};
  walk(root); const report=analyzeCompatibility(files); fs.writeFileSync(path.join(root,'wybuild-compat-report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({status:report.summary.status,files:report.summary.filesScanned,findings:report.findings.length,blocking:report.summary.blocking}));
  if(report.summary.blocking && process.env.WYBUILD_COMPAT_STRICT==='1') process.exitCode=2;
}
