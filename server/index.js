import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load server/.env regardless of the working directory (root `npm run server` used to read the frontend .env instead).
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config(); // optional fallback to ./.env or real environment variables; never overrides values already set
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1)); // required behind Render/Railway/Vercel/Nginx or every user shares one rate-limit bucket
const port = Number(process.env.PORT || 8787);
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '').split(',').map(x=>x.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}}));
const capacitorOrigins = new Set(['capacitor://localhost','ionic://localhost','http://localhost','https://localhost']);
app.use(cors({origin:(origin,cb)=>{
  // Native Capacitor WebViews use localhost origins; allow those without opening CORS to every website.
  if(!origin || capacitorOrigins.has(origin) || allowedOrigins.includes(origin)) return cb(null,true);
  // In local development, an empty allow-list is convenient. Production must set ALLOWED_ORIGIN explicitly.
  if(!allowedOrigins.length && process.env.NODE_ENV !== 'production') return cb(null,true);
  return cb(new Error('Origin not allowed'));
},credentials:false}));
app.use(express.json({limit:'20mb',verify:(req,_res,buf)=>{if(req.originalUrl.startsWith('/api/billing/webhook'))req.rawBody=buf;}}));
app.use('/api/',rateLimit({windowMs:60_000,limit:40,standardHeaders:true,legacyHeaders:false}));
app.use('/api/image',rateLimit({windowMs:60*60_000,limit:8,standardHeaders:true,legacyHeaders:false}));

let firebaseReady=false;
try {
  if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON){
    const serviceAccount=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({credential:admin.credential.cert(serviceAccount)}); firebaseReady=true;
  } else if(process.env.GOOGLE_APPLICATION_CREDENTIALS){ admin.initializeApp({credential:admin.credential.applicationDefault()}); firebaseReady=true; }
} catch(e){ console.error('Firebase Admin initialization failed:',e.message); }
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}) : null;
// Firestore is a fallback store for push-device registrations only; it does not replace Supabase for accounts, credits, or posts.
const firestore = firebaseReady ? admin.firestore() : null;
const pushCollection = () => firestore.collection('wyticlePushDevices');
const pushDocId = token => crypto.createHash('sha256').update(String(token)).digest('hex');
async function listPushDevices(uid){
  if(supabase){
    try { const {data,error}=await supabase.from('wryte_push_devices').select('token').eq('user_id',String(uid)).eq('active',true).limit(20); if(error)throw error; return data||[]; }
    catch(e){ console.warn('Supabase push registry unavailable; using Firestore fallback:',e.message); }
  }
  if(!firestore) return [];
  const snap=await pushCollection().where('userId','==',String(uid)).limit(100).get();
  return snap.docs.filter(d=>d.get('active')===true).slice(0,20).map(d=>({token:d.get('token'),docId:d.id})).filter(d=>d.token);
}
async function savePushDevice(uid,token,platform){
  let supabaseError=null;
  if(supabase){try{const {error}=await supabase.from('wryte_push_devices').upsert({user_id:String(uid),token,platform,active:true,updated_at:new Date().toISOString()},{onConflict:'token'});if(!error)return 'supabase';supabaseError=error;}catch(e){supabaseError=e;}}
  if(firestore){await pushCollection().doc(pushDocId(token)).set({userId:String(uid),token,platform,active:true,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return 'firestore';}
  throw supabaseError||new Error('No push-device registry is configured.');
}
async function deactivatePushDevice(uid,token){
  let supabaseError=null;
  if(supabase){try{const {error}=await supabase.from('wryte_push_devices').update({active:false,updated_at:new Date().toISOString()}).eq('user_id',String(uid)).eq('token',token);if(!error)return;supabaseError=error;}catch(e){supabaseError=e;}}
  if(firestore){const ref=pushCollection().doc(pushDocId(token));const doc=await ref.get();if(doc.exists&&doc.get('userId')===String(uid))await ref.set({active:false,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return;}
  if(supabaseError)throw supabaseError;throw new Error('No push-device registry is configured.');
}
const OPENAI_API_KEY=process.env.OPENAI_API_KEY;
const OPENAI_MODEL=process.env.OPENAI_MODEL||'gpt-4.1-mini';
const APP_URL=(process.env.APP_URL||'http://localhost:5173').replace(/\/$/,'');
const API_PUBLIC_URL=(process.env.API_PUBLIC_URL||'http://localhost:8787').replace(/\/$/,'');

function requiredEnv(names){return names.filter(n=>!process.env[n]);}
function encrypt(text){
  const key=Buffer.from(process.env.TOKEN_ENCRYPTION_KEY||'','base64');
  if(key.length!==32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(String(text),'utf8'),cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}
function decrypt(value){
  const key=Buffer.from(process.env.TOKEN_ENCRYPTION_KEY||'','base64'); if(key.length!==32) throw new Error('TOKEN_ENCRYPTION_KEY must be configured');
  const [iv,tag,data]=String(value).split('.'); const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64')); d.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([d.update(Buffer.from(data,'base64')),d.final()]).toString('utf8');
}
async function auth(req,res,next){
  try{
    const header=req.headers.authorization||''; const token=header.startsWith('Bearer ')?header.slice(7):'';
    if(!token) return res.status(401).json({error:'Sign in to continue.'});
    if(!firebaseReady) return res.status(503).json({error:'Server authentication is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON.'});
    const decoded=await admin.auth().verifyIdToken(token,true); req.user={uid:decoded.uid,email:decoded.email||'',name:decoded.name||'',picture:decoded.picture||''}; next();
  }catch(e){return res.status(401).json({error:'Your session has expired. Sign in again.'});}
}
function safeEqual(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);} // compares BYTE lengths; timingSafeEqual throws on unequal buffers
function dbRequired(req,res,next){if(!supabase)return res.status(503).json({error:'Account database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'});next();}
async function sendPushToUser(uid,{title,body,type,projectId}={}){
  if(!firebaseReady||!uid)return;
  try{
    const devices=await listPushDevices(uid);
    for(const device of devices){
      try{await admin.messaging().send({token:device.token,notification:{title:String(title||'Wyticle AI').slice(0,120),body:String(body||'Your update is ready.').slice(0,240)},data:{type:String(type||'update'),...(projectId?{projectId:String(projectId)}:{})},android:{priority:'high',notification:{channelId:'wyticle-updates',sound:'default'}},apns:{payload:{aps:{sound:'default'}}}});}
      catch(e){if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(e.code)){try{await deactivatePushDevice(uid,device.token);}catch(cleanupError){console.warn('Could not deactivate invalid push token:',cleanupError.message);}}else console.warn('Push delivery failed:',e.code||e.message);}
    }
  }catch(e){console.warn('Push notification skipped:',e.message);}
}
async function ensureWallet(uid){
  let {data,error}=await supabase.from('wryte_wallets').select('*').eq('user_id',uid).maybeSingle(); if(error)throw error;
  if(!data){const r=await supabase.from('wryte_wallets').insert({user_id:uid,credits:0,free_generations_used:0,trial_project_ids:[]}).select('*').single(); if(r.error && r.error.code!=='23505')throw r.error; if(r.data)data=r.data; else {const again=await supabase.from('wryte_wallets').select('*').eq('user_id',uid).single(); if(again.error)throw again.error;data=again.data;}}
  return data;
}
app.get('/health',(_req,res)=>res.json({ok:true,service:'wyticle-ai-api',authConfigured:firebaseReady,databaseConfigured:Boolean(supabase),aiConfigured:Boolean(OPENAI_API_KEY)}));
app.post('/api/push/register',auth,async(req,res)=>{
  const token=String(req.body?.token||'').trim();const platform=String(req.body?.platform||'unknown');
  if(token.length<40||token.length>4096||!/^[A-Za-z0-9_./:-]+$/.test(token))return res.status(400).json({error:'Invalid push registration token.'});
  if(!['android','ios'].includes(platform))return res.status(400).json({error:'Unsupported native push platform.'});
  try{const storage=await savePushDevice(req.user.uid,token,platform);res.json({ok:true,storage});}
  catch(e){console.error('Push registration:',e.message);res.status(503).json({error:'Unable to register this device. Configure Supabase or Firebase Admin with Firestore enabled.'});}
});
app.delete('/api/push/register',auth,async(req,res)=>{const token=String(req.body?.token||'').trim();if(!token)return res.status(400).json({error:'Push token is required.'});try{await deactivatePushDevice(req.user.uid,token);res.json({ok:true});}catch(e){res.status(503).json({error:'Unable to unregister this device.'});}});

app.get('/api/me',auth,dbRequired,async(req,res)=>{try{const w=await ensureWallet(req.user.uid);res.json({user:req.user,wallet:{credits:w.credits,freeGenerationsRemaining:Math.max(0,2-(w.free_generations_used||0))},connectedSites:await listSites(req.user.uid)});}catch(e){console.error(e);res.status(500).json({error:'Unable to load your account.'});}});
function isPrivateAddress(a){if(net.isIPv6(a)){const l=a.toLowerCase();return l==='::1'||l==='::'||l.startsWith('fc')||l.startsWith('fd')||l.startsWith('fe8')||l.startsWith('fe9')||l.startsWith('fea')||l.startsWith('feb')||l.startsWith('::ffff:');}const [x,y]=a.split('.').map(Number);return x===0||x===10||x===127||(x===100&&y>=64&&y<=127)||(x===169&&y===254)||(x===172&&y>=16&&y<=31)||(x===192&&y===168)||x>=224;}
async function assertPublicHost(hostname){const h=hostname.replace(/^\[|\]$/g,'');if(net.isIP(h))throw new Error('Use your site domain name, not an IP address.');const addrs=await dns.lookup(h,{all:true});if(!addrs.length||addrs.some(x=>isPrivateAddress(x.address)))throw new Error('That site resolves to a private network address.');}
async function listSites(uid){const {data,error}=await supabase.from('wryte_connections').select('id,provider,site_url,blog_id,blog_name,created_at').eq('user_id',uid);if(error)throw error;return data||[];}
app.get('/api/sites',auth,dbRequired,async(req,res)=>{try{res.json({sites:await listSites(req.user.uid)});}catch(e){res.status(500).json({error:'Unable to load connected sites.'});}});

// Blogger OAuth: short-lived state is server stored and tied to a verified Firebase user.
app.post('/api/connect/blogger/start',auth,dbRequired,async(req,res)=>{
  const missing=requiredEnv(['GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET','TOKEN_ENCRYPTION_KEY']);if(missing.length)return res.status(503).json({error:`Blogger OAuth setup missing: ${missing.join(', ')}`});
  try{const state=crypto.randomBytes(32).toString('hex');const expires=new Date(Date.now()+10*60_000).toISOString();let returnUrl=APP_URL;try{const requested=new URL(req.body?.returnUrl||APP_URL);if(requested.origin===APP_URL||requested.protocol==='ai.wryte.app:')returnUrl=requested.toString();}catch{} await ensureWallet(req.user.uid);const {error}=await supabase.from('wryte_oauth_states').insert({state_hash:crypto.createHash('sha256').update(state).digest('hex'),user_id:req.user.uid,provider:'blogger',expires_at:expires,return_url:returnUrl});if(error)throw error;
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.searchParams.set('client_id',process.env.GOOGLE_OAUTH_CLIENT_ID);url.searchParams.set('redirect_uri',`${API_PUBLIC_URL}/api/connect/blogger/callback`);url.searchParams.set('response_type','code');url.searchParams.set('scope','https://www.googleapis.com/auth/blogger https://www.googleapis.com/auth/drive');url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');url.searchParams.set('state',state);res.json({url:url.toString()});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to start Blogger authorization.'});}
});
app.get('/api/connect/blogger/callback',async(req,res)=>{
  const {code,state,error:oauthError}=req.query;if(oauthError)return res.redirect(`${APP_URL}/?connect=blogger_failed`);if(typeof code!=='string'||typeof state!=='string')return res.status(400).send('Invalid OAuth callback.');
  try{if(!supabase)throw new Error('Database not configured');const hash=crypto.createHash('sha256').update(state).digest('hex');const {data:st,error}=await supabase.from('wryte_oauth_states').select('*').eq('state_hash',hash).eq('provider','blogger').gt('expires_at',new Date().toISOString()).maybeSingle();if(error||!st) return res.status(400).send('OAuth state expired or invalid. Return to Wyticle AI and connect again.');const returnUrl=st.return_url||APP_URL;await supabase.from('wryte_oauth_states').delete().eq('state_hash',hash);
    const tokenResp=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:process.env.GOOGLE_OAUTH_CLIENT_ID,client_secret:process.env.GOOGLE_OAUTH_CLIENT_SECRET,redirect_uri:`${API_PUBLIC_URL}/api/connect/blogger/callback`,grant_type:'authorization_code'})});const tokens=await tokenResp.json();if(!tokenResp.ok||!tokens.access_token)throw new Error('Google token exchange failed');
    const oldDrive=await supabase.from('wryte_drive_settings').select('folder_id,refresh_token_enc').eq('user_id',st.user_id).maybeSingle();
    const driveRow={user_id:st.user_id,folder_id:oldDrive.data?.folder_id||null,access_token_enc:encrypt(tokens.access_token),refresh_token_enc:tokens.refresh_token?encrypt(tokens.refresh_token):(oldDrive.data?.refresh_token_enc||null),token_expiry:tokens.expires_in?new Date(Date.now()+tokens.expires_in*1000).toISOString():null,updated_at:new Date().toISOString()};
    const driveSave=await supabase.from('wryte_drive_settings').upsert(driveRow,{onConflict:'user_id'});if(driveSave.error)throw driveSave.error;
    const blogsResp=await fetch('https://www.googleapis.com/blogger/v3/users/self/blogs',{headers:{Authorization:`Bearer ${tokens.access_token}`}});const blogs=await blogsResp.json();if(!blogsResp.ok)throw new Error('Unable to list Blogger blogs');
    for(const blog of (blogs.items||[])){const row={user_id:st.user_id,provider:'blogger',blog_id:String(blog.id),blog_name:blog.name||'Blogger blog',site_url:blog.url||null,access_token_enc:encrypt(tokens.access_token),refresh_token_enc:tokens.refresh_token?encrypt(tokens.refresh_token):undefined,token_expiry:tokens.expires_in?new Date(Date.now()+tokens.expires_in*1000).toISOString():null};const existing=await supabase.from('wryte_connections').select('id').eq('user_id',st.user_id).eq('provider','blogger').eq('blog_id',String(blog.id)).maybeSingle();if(existing.data)await supabase.from('wryte_connections').update(row).eq('id',existing.data.id);else await supabase.from('wryte_connections').insert(row);}
    res.redirect(returnUrl.startsWith('ai.wryte.app:')?`${returnUrl}${returnUrl.includes('?')?'&':'?'}connect=blogger_success`:`${returnUrl.replace(/\/$/,'')}/?connect=blogger_success`);
  }catch(e){console.error('Blogger OAuth callback:',e.message);res.redirect(`${APP_URL}/?connect=blogger_failed`);}
});
// Google Drive archive settings and TXT export. Drive OAuth tokens are encrypted server-side.
async function getDriveSettings(uid){const {data,error}=await supabase.from('wryte_drive_settings').select('user_id,folder_id,access_token_enc,refresh_token_enc,token_expiry').eq('user_id',uid).maybeSingle();if(error)throw error;return data;}
async function getDriveAccessToken(uid){
  const row=await getDriveSettings(uid);if(!row?.refresh_token_enc)throw new Error('Reconnect Google access to enable Drive exports.');
  if(row.access_token_enc&&row.token_expiry&&Date.parse(row.token_expiry)>Date.now()+60_000)return decrypt(row.access_token_enc);
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_OAUTH_CLIENT_ID,client_secret:process.env.GOOGLE_OAUTH_CLIENT_SECRET,refresh_token:decrypt(row.refresh_token_enc),grant_type:'refresh_token'}),signal:AbortSignal.timeout(12000)});
  const d=await r.json();if(!r.ok||!d.access_token)throw new Error('Google Drive authorization expired. Reconnect Google access.');
  await supabase.from('wryte_drive_settings').update({access_token_enc:encrypt(d.access_token),token_expiry:new Date(Date.now()+Number(d.expires_in||3600)*1000).toISOString(),updated_at:new Date().toISOString()}).eq('user_id',uid);return d.access_token;
}
app.get('/api/drive/settings',auth,dbRequired,async(req,res)=>{try{const row=await getDriveSettings(req.user.uid);res.json({folderId:row?.folder_id||'',connected:Boolean(row?.refresh_token_enc),configured:Boolean(row?.folder_id)});}catch(e){res.status(500).json({error:'Unable to load Google Drive settings.'});}});
app.put('/api/drive/settings',auth,dbRequired,async(req,res)=>{
  try{
    const folderId=String(req.body?.folderId||'').trim();const old=await getDriveSettings(req.user.uid);
    if(!folderId){let clear;if(old){clear=await supabase.from('wryte_drive_settings').update({folder_id:null,updated_at:new Date().toISOString()}).eq('user_id',req.user.uid);}else{clear=await supabase.from('wryte_drive_settings').upsert({user_id:req.user.uid,folder_id:null,updated_at:new Date().toISOString()},{onConflict:'user_id'});}if(clear.error)throw clear.error;return res.json({ok:true,folderId:'',configured:false,connected:Boolean(old?.refresh_token_enc)});}
    if(folderId.length>200||/[\s<>"'\\]/.test(folderId))return res.status(400).json({error:'Enter the folder ID copied from the Google Drive folder URL.'});
    const token=await getDriveAccessToken(req.user.uid);const r=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,capabilities(canAddChildren),webViewLink&supportsAllDrives=true`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});const meta=await r.json();
    if(!r.ok){if(r.status===403||r.status===401)return res.status(400).json({error:'Wyticle could not access that folder. Reconnect Google Drive access and check that the folder belongs to the connected Google account.'});return res.status(400).json({error:meta.error?.message||'That Drive folder could not be found.'});}
    if(meta.mimeType!=='application/vnd.google-apps.folder')return res.status(400).json({error:'That ID belongs to a file, not a Google Drive folder.'});if(meta.capabilities?.canAddChildren===false)return res.status(400).json({error:'You have view-only access to this folder. Choose a folder where you can add files.'});
    const {error}=await supabase.from('wryte_drive_settings').update({folder_id:folderId,updated_at:new Date().toISOString()}).eq('user_id',req.user.uid);if(error)throw error;res.json({ok:true,folderId,folderName:meta.name,folderUrl:meta.webViewLink||null,configured:true,connected:true});
  }catch(e){console.error('Drive settings:',e.message);res.status(500).json({error:e.message||'Unable to save Google Drive settings.'});}
});
// List only Wyticle TXT exports inside the authenticated user's configured Drive folder.
app.get('/api/drive/files',auth,dbRequired,async(req,res)=>{
  try{
    const row=await getDriveSettings(req.user.uid);
    if(!row?.folder_id)return res.status(400).json({error:'Configure and save a Google Drive folder ID first.'});
    const token=await getDriveAccessToken(req.user.uid);const files=[];let pageToken='';
    for(let page=0;page<10;page++){
      const params=new URLSearchParams({q:`'${row.folder_id.replace(/'/g,"\\'")}' in parents and mimeType='text/plain' and trashed=false`,fields:'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,appProperties)',pageSize:'100',orderBy:'modifiedTime desc',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});
      if(pageToken)params.set('pageToken',pageToken);
      const r=await fetch(`https://www.googleapis.com/drive/v3/files?${params}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});const data=await r.json();
      if(!r.ok)throw new Error(data.error?.message||'Could not list files in that Google Drive folder.');
      files.push(...(data.files||[]).filter(f=>Boolean(f.appProperties?.wryteProjectId)).map(f=>({id:f.id,name:f.name||'Wyticle article.txt',size:Number(f.size||0),modifiedTime:f.modifiedTime||null,url:f.webViewLink||`https://drive.google.com/file/d/${f.id}/view`,projectId:f.appProperties.wryteProjectId})));
      pageToken=data.nextPageToken||'';if(!pageToken)break;
    }
    res.json({files,folderId:row.folder_id,count:files.length});
  }catch(e){console.error('Drive files list:',e.message);res.status(500).json({error:e.message||'Unable to list Drive exports.'});}
});
app.get('/api/drive/files/:fileId/download',auth,dbRequired,async(req,res)=>{
  try{
    const fileId=String(req.params.fileId||'');if(!/^[a-zA-Z0-9_-]{5,200}$/.test(fileId))return res.status(400).json({error:'Invalid Drive file ID.'});
    const row=await getDriveSettings(req.user.uid);if(!row?.folder_id)return res.status(400).json({error:'Configure a Google Drive folder first.'});
    const token=await getDriveAccessToken(req.user.uid);
    const metaResp=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents,trashed&supportsAllDrives=true`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});const meta=await metaResp.json();
    if(!metaResp.ok)throw new Error(meta.error?.message||'Drive file not found.');
    if(meta.trashed||meta.mimeType!=='text/plain'||!(meta.parents||[]).includes(row.folder_id))return res.status(403).json({error:'That file is not a TXT export in your configured Wyticle folder.'});
    const download=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
    if(!download.ok)throw new Error('Google Drive could not download that TXT file.');
    const content=Buffer.from(await download.arrayBuffer());const safeName=String(meta.name||'wyticle-article.txt').replace(/[\\/:*?"<>|\r\n]+/g,'_').slice(0,180);
    res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${safeName}"`);res.setHeader('Content-Length',content.length);res.send(content);
  }catch(e){console.error('Drive file download:',e.message);res.status(500).json({error:e.message||'Unable to download Drive export.'});}
});

function htmlToPlainText(html=''){
  return String(html).replace(/<\/(p|div|h[1-6]|li|blockquote|figure|section|tr)>/gi,'\n').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<li\b[^>]*>/gi,'• ').replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,Number(n)||0))).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function articleTxt(project){const seo=project.seo||{};const lines=[String(project.title||'Untitled article'),'='.repeat(Math.min(80,String(project.title||'Untitled article').length)),''];if(seo.title)lines.push(`SEO title: ${seo.title}`);if(seo.description)lines.push(`Meta description: ${seo.description}`);if(Array.isArray(seo.keywords)&&seo.keywords.length)lines.push(`Keywords: ${seo.keywords.join(', ')}`);if(seo.slug)lines.push(`Suggested URL slug: ${seo.slug}`);if(lines.length>3)lines.push('');lines.push(htmlToPlainText(project.body||''),'',`Exported from Wyticle AI on ${new Date().toISOString()}`);return lines.join('\n').trim()+'\n';}
async function saveArticleTxtToDrive(uid,project){
  const row=await getDriveSettings(uid);if(!row?.folder_id)return null;
  const token=await getDriveAccessToken(uid);const id=String(project.id||crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,120)||crypto.randomUUID();const title=String(project.title||'Wyticle article').replace(/[\\/:*?"<>|\r\n]+/g,' ').trim().slice(0,100)||'Wyticle article';const name=`${title} - ${id}.txt`;const content=articleTxt(project);const q=`'${row.folder_id.replace(/'/g,"\\'")}' in parents and appProperties has { key='wryteProjectId' and value='${id}' } and trashed = false`;
  const search=await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({q,fields:'files(id,name,webViewLink)',pageSize:'10',supportsAllDrives:'true',includeItemsFromAllDrives:'true'})}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});const found=await search.json();if(!search.ok)throw new Error(found.error?.message||'Could not check for an existing Drive export.');
  let meta;
  if(found.files?.length){meta=found.files[0];const update=await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(meta.id)}?uploadType=media&supportsAllDrives=true`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'text/plain; charset=utf-8'},body:content,signal:AbortSignal.timeout(20000)});if(!update.ok){const d=await update.json().catch(()=>({}));throw new Error(d.error?.message||'Could not update the existing Drive text file.');}await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(meta.id)}?fields=id,name,webViewLink&supportsAllDrives=true`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name}),signal:AbortSignal.timeout(12000)}).then(async r=>{if(r.ok)meta=await r.json();});}
  else {const form=new FormData();form.append('metadata',new Blob([JSON.stringify({name,mimeType:'text/plain',parents:[row.folder_id],appProperties:{wryteProjectId:id}})],{type:'application/json'}));form.append('file',new Blob([content],{type:'text/plain;charset=utf-8'}),name);const r=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(20000)});meta=await r.json();if(!r.ok)throw new Error(meta.error?.message||'Google Drive could not save the TXT file.');}
  return {destination:'Google Drive TXT',status:'success',id:meta.id,url:meta.webViewLink||`https://drive.google.com/file/d/${meta.id}/view`,fileName:meta.name||name};
}

// Allow-list HTML sanitizer for anything published to Blogger. It tokenizes in a single linear pass, rebuilds every tag from
// scratch with only allow-listed attributes, and keeps the output balanced so stray closing tags cannot escape the post container.
const SAFE_HTML_TAGS=new Set(['a','p','br','h1','h2','h3','h4','h5','h6','ul','ol','li','strong','b','em','i','u','s','blockquote','pre','code','hr','img','figure','figcaption','table','thead','tbody','tfoot','tr','th','td','span','div','section','article','sup','sub','mark','iframe']);
const VOID_HTML_TAGS=new Set(['br','hr','img']);
const RAW_HTML_TAGS=new Set(['script','style','noscript','template','textarea','xmp','plaintext','title','noembed','noframes']);
function decodeHtmlEntities(v=''){return String(v).replace(/&#x([0-9a-f]+);?/gi,(_,h)=>String.fromCodePoint(Math.min(0x10ffff,parseInt(h,16)||0))).replace(/&#(\d+);?/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,Number(n)||0))).replace(/&colon;/gi,':').replace(/&tab;/gi,'\t').replace(/&newline;/gi,'\n').replace(/&amp;/gi,'&');}
function safeUrl(value,{image=false}={}){
  const norm=decodeHtmlEntities(value).replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]+/g,'');
  if(!norm)return '';
  if(image&&/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(norm))return norm;
  const scheme=norm.match(/^([a-z][a-z0-9+.-]*):/i);
  if(scheme)return /^(https?|mailto|tel)$/i.test(scheme[1])?String(value).trim():'';
  return String(value).trim();
}
function safeStyle(value){const d=decodeHtmlEntities(value);return /[\\<>]|expression|url\s*\(|javascript:|@import|behavior|binding|position\s*:\s*(fixed|absolute|sticky)/i.test(d)?'':String(value).trim();}
function safeEmbedUrl(value){try{const u=new URL(decodeHtmlEntities(value).trim());const yt=u.hostname==='www.youtube-nocookie.com'&&/^\/embed\/[A-Za-z0-9_-]+$/.test(u.pathname);const vm=u.hostname==='player.vimeo.com'&&/^\/video\/\d+$/.test(u.pathname);return u.protocol==='https:'&&(yt||vm)?`${u.origin}${u.pathname}`:'';}catch{return '';}}
function parseHtmlAttrs(src=''){const out=[];const re=/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;let m;while((m=re.exec(src)))out.push([m[1].toLowerCase(),m[2]??m[3]??m[4]??'']);return out;}
const escAttr=v=>String(v).replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function cleanHtml(input=''){
  const html=String(input).replace(/\u0000/g,'');const n=html.length;const out=[];const stack=[];let i=0;
  const text=t=>{if(t)out.push(t.replace(/</g,'&lt;'));};
  while(i<n){
    const lt=html.indexOf('<',i);
    if(lt<0){text(html.slice(i));break;}
    text(html.slice(i,lt));
    if(html.startsWith('<!--',lt)){const end=html.indexOf('-->',lt+4);i=end<0?n:end+3;continue;}
    let j=lt+1;const closing=html[j]==='/';if(closing)j++;
    if(!/[a-zA-Z]/.test(html[j]||'')){
      if(html[lt+1]==='!'||html[lt+1]==='?'){const end=html.indexOf('>',lt+1);i=end<0?n:end+1;continue;} // doctype / processing instruction / CDATA
      out.push('&lt;');i=lt+1;continue; // a literal "<" such as "a < b"
    }
    let k=j;while(k<n&&/[a-zA-Z0-9:-]/.test(html[k]))k++;
    const name=html.slice(j,k).toLowerCase();
    let q='',m=k,found=false;
    for(;m<n;m++){const c=html[m];if(q){if(c===q)q='';}else if(c==='"'||c==="'")q=c;else if(c==='>'){found=true;break;}}
    if(!found){text(html.slice(lt));break;} // unterminated tag: keep the remainder as inert text (linear time, never executable)
    const attrSrc=html.slice(k,m);i=m+1;
    if(closing){const idx=stack.lastIndexOf(name);if(idx>=0){while(stack.length-1>idx)out.push(`</${stack.pop()}>`);out.push(`</${stack.pop()}>`);}continue;}
    if(RAW_HTML_TAGS.has(name)){const re=new RegExp(`</${name}\\s*>`,'ig');re.lastIndex=i;const f=re.exec(html);i=f?f.index+f[0].length:n;continue;} // drop script/style and their contents
    if(!SAFE_HTML_TAGS.has(name))continue;
    const attrs=parseHtmlAttrs(attrSrc);const get=a=>attrs.find(x=>x[0]===a)?.[1];const keep=[];const add=(key,val)=>keep.push(`${key}="${escAttr(val)}"`);
    const cls=get('class');if(cls)add('class',cls.replace(/[^\w\s-]/g,'').slice(0,200));
    const title=get('title');if(title&&name!=='iframe')add('title',title.slice(0,300));
    const style=get('style');if(style){const st=safeStyle(style);if(st)add('style',st);}
    if(name==='a'){const href=safeUrl(get('href')||'');if(href)add('href',href);if(href&&get('target')==='_blank'){add('target','_blank');add('rel','noopener noreferrer');}}
    else if(name==='img'){const src=safeUrl(get('src')||'',{image:true});if(!src)continue;add('src',src);add('alt',(get('alt')||'').slice(0,500));const w=String(get('width')||'').replace(/\D/g,'').slice(0,5),h=String(get('height')||'').replace(/\D/g,'').slice(0,5);if(w)add('width',w);if(h)add('height',h);add('loading','lazy');}
    else if(name==='td'||name==='th'){for(const key of ['colspan','rowspan']){const v=String(get(key)||'').replace(/\D/g,'').slice(0,2);if(v)add(key,v);}}
    else if(name==='iframe'){const src=safeEmbedUrl(get('src')||'');if(!src)continue;keep.length=0;add('src',src);add('title','Embedded video');add('loading','lazy');keep.push('allowfullscreen');}
    out.push(`<${name}${keep.length?' '+keep.join(' '):''}>`);
    if(!VOID_HTML_TAGS.has(name))stack.push(name);
  }
  while(stack.length)out.push(`</${stack.pop()}>`);
  return out.join('');
}
async function getConnection(uid,provider,id){let q=supabase.from('wryte_connections').select('*').eq('user_id',uid).eq('provider',provider);if(id)q=q.eq('id',id);const {data,error}=await q.limit(1).maybeSingle();if(error)throw error;if(!data)throw new Error(`No connected ${provider} site was found.`);return data;}
async function getBloggerAccess(conn){if(conn.token_expiry&&Date.parse(conn.token_expiry)>Date.now()+60_000)return decrypt(conn.access_token_enc);if(!conn.refresh_token_enc)throw new Error('Blogger authorization expired. Reconnect Blogger.');const rr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_OAUTH_CLIENT_ID,client_secret:process.env.GOOGLE_OAUTH_CLIENT_SECRET,refresh_token:decrypt(conn.refresh_token_enc),grant_type:'refresh_token'})});const data=await rr.json();if(!rr.ok||!data.access_token)throw new Error('Blogger token refresh failed. Reconnect Blogger.');await supabase.from('wryte_connections').update({access_token_enc:encrypt(data.access_token),token_expiry:new Date(Date.now()+(data.expires_in||3600)*1000).toISOString()}).eq('id',conn.id);return data.access_token;}
async function publishProject(uid,project,destinations={},siteIds={},draft=false){
  if(!project||!project.title||!project.body)throw new Error('An article title and body are required.');
  if(!destinations.blogger)throw new Error('Choose Blogger as the publishing destination.');
  const results=[];const html=cleanHtml(project.body);const title=String(project.title).slice(0,500);
  if(destinations.blogger){try{const c=await getConnection(uid,'blogger',siteIds.blogger);const token=await getBloggerAccess(c);const url=`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(c.blog_id)}/posts${draft?'?isDraft=true':''}`;const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({kind:'blogger#post',title,content:html}),signal:AbortSignal.timeout(20000)});const data=await r.json();if(!r.ok)throw new Error(data.error?.message||'Blogger rejected the post.');results.push({destination:'Blogger',status:'success',id:data.id,url:data.url||null,draft,...(String(project.featuredImage||'').startsWith('data:image/')?{warning:'The article was published, but the featured image was not uploaded to Blogger. Blogger requires a publicly hosted image URL for this image workflow.'}:{})});}catch(e){results.push({destination:'Blogger',status:'failed',message:e.message});}}
  if(!draft){try{const driveRow=await getDriveSettings(uid);if(driveRow?.folder_id){try{results.push(await saveArticleTxtToDrive(uid,project));}catch(e){results.push({destination:'Google Drive TXT',status:'failed',message:e.message||'Could not save the TXT archive.'});}}}catch(e){if(e.code!=='42P01')results.push({destination:'Google Drive TXT',status:'failed',message:'Could not read Google Drive settings.'});else console.warn('Drive TXT archive table is not installed yet; run the Google Drive archive migration.');}}
  return results;
}
app.post('/api/publish',auth,dbRequired,async(req,res)=>{try{const {project,destinations={},siteIds={}}=req.body||{};if(!project||!project.title||!project.body)return res.status(400).json({error:'An article title and body are required.'});if(!destinations.blogger)return res.status(400).json({error:'Choose Blogger as the publishing destination.'});res.json({results:await publishProject(req.user.uid,project,destinations,siteIds,Boolean(req.body.draft))});}catch(e){res.status(400).json({error:e.message||'Unable to publish.'});}});
function compactScheduledProject(project){
  // Keep only what the publisher needs; avoid copying editor history, undo stacks or other UI state.
  return {
    id:String(project.id||crypto.randomUUID()),
    title:String(project.title||'').slice(0,500),
    body:String(project.body||''),
    seo:project.seo&&typeof project.seo==='object'?{title:String(project.seo.title||'').slice(0,300),description:String(project.seo.description||'').slice(0,1000),slug:String(project.seo.slug||'').slice(0,200),keywords:Array.isArray(project.seo.keywords)?project.seo.keywords.slice(0,30).map(x=>String(x).slice(0,100)):[]}: {},
    featuredImage:typeof project.featuredImage==='string'?project.featuredImage.slice(0,12_000_000):'',
    excerpt:String(project.excerpt||'').slice(0,1000)
  };
}
app.post('/api/publish/schedule',auth,dbRequired,async(req,res)=>{
  const {project,destinations={},siteIds={},scheduledAt}=req.body||{};
  if(!project||typeof project.title!=='string'||!project.title.trim()||typeof project.body!=='string'||!project.body.trim())return res.status(400).json({error:'An article title and body are required.'});
  if(!destinations.blogger)return res.status(400).json({error:'Choose Blogger as the publishing destination.'});
  const due=new Date(scheduledAt);if(!scheduledAt||Number.isNaN(due.getTime())||due.getTime()<Date.now()+60_000)return res.status(400).json({error:'Choose a valid future publishing time at least one minute from now.'});
  const maxScheduleDays=Math.max(1,Math.min(90,Number(process.env.SCHEDULE_MAX_DAYS||90)));
  if(due.getTime()>Date.now()+maxScheduleDays*24*60*60*1000)return res.status(400).json({error:`Scheduling is limited to ${maxScheduleDays} days ahead.`});
  try{
    await getConnection(req.user.uid,'blogger',siteIds.blogger);
    const storedProject=compactScheduledProject(project);
    const payloadBytes=Buffer.byteLength(JSON.stringify(storedProject),'utf8');
    if(payloadBytes>8*1024*1024)return res.status(413).json({error:'This scheduled article is too large to queue. Reduce embedded image data or use an image URL, then try again.'});
    const schedulePayload={user_id:req.user.uid,project_id:storedProject.id,project:storedProject,destinations:{blogger:true},site_ids:{blogger:siteIds.blogger},due_at:due.toISOString(),content_expires_at:new Date(due.getTime()+7*24*60*60*1000).toISOString(),status:'pending'};
    // Atomic database admission control prevents simultaneous requests from exceeding queue limits.
    const {data,error}=await supabase.rpc('wryte_enqueue_scheduled_post',{p_user_id:schedulePayload.user_id,p_project_id:schedulePayload.project_id,p_project:schedulePayload.project,p_destinations:schedulePayload.destinations,p_site_ids:schedulePayload.site_ids,p_due_at:schedulePayload.due_at,p_content_expires_at:schedulePayload.content_expires_at,p_user_limit:Math.max(1,Number(process.env.SCHEDULE_MAX_ACTIVE_PER_USER||10)),p_global_limit:Math.max(1,Number(process.env.SCHEDULE_MAX_ACTIVE_GLOBAL||500))});
    if(error)throw error;
    const queued=data?.row||data;
    if(data?.ok===false){const status=data.code==='GLOBAL_LIMIT'?503:429;return res.status(status).json({error:data.error||'The scheduled publishing queue is currently full. Please try again later.',code:data.code||'SCHEDULE_LIMIT'});}
    if(!queued?.id)throw new Error('The scheduler did not confirm the queued article. Apply the scheduling limits SQL migration and try again.');
    res.status(201).json({id:queued.id,scheduledAt:queued.due_at||schedulePayload.due_at,status:queued.status||'pending',limits:{maxActivePerAccount:Math.max(1,Number(process.env.SCHEDULE_MAX_ACTIVE_PER_USER||10)),maxActiveGlobal:Math.max(1,Number(process.env.SCHEDULE_MAX_ACTIVE_GLOBAL||500)),maxDaysAhead:maxScheduleDays},storagePolicy:'Article content is removed after successful delivery; failed jobs retain it for up to 7 days.'});
  }catch(e){console.error('Schedule publish:',e.message);res.status(400).json({error:e.message||'Could not schedule this article.'});}
});
app.get('/api/publish/scheduled',auth,dbRequired,async(req,res)=>{try{const {data,error}=await supabase.from('wryte_scheduled_posts').select('id,project_id,due_at,status,results,error_message,created_at').eq('user_id',req.user.uid).order('due_at',{ascending:true}).limit(100);if(error)throw error;res.json({scheduled:data||[]});}catch(e){res.status(500).json({error:'Unable to load scheduled articles.'});}});
// A database-backed worker runs independently of the mobile app. Keep the API process deployed
// continuously, or use an external scheduler to invoke a worker for reliable production delivery.
let scheduleWorkerRunning=false;
async function processScheduledPosts(){
  if(!supabase||scheduleWorkerRunning)return;scheduleWorkerRunning=true;
  try{
    const nowIso=new Date().toISOString();
    // Purge expired content payloads but retain tiny status/result metadata for the user's history.
    const {error:purgeError}=await supabase.from('wryte_scheduled_posts').update({project:null,content_purged_at:nowIso,updated_at:nowIso}).not('project','is',null).lte('content_expires_at',nowIso);
    if(purgeError)throw purgeError;
    await supabase.from('wryte_scheduled_posts').update({status:'pending',updated_at:nowIso}).eq('status','processing').lt('updated_at',new Date(Date.now()-5*60_000).toISOString());
    const {data:due,error}=await supabase.from('wryte_scheduled_posts').select('*').eq('status','pending').lte('due_at',nowIso).order('due_at',{ascending:true}).limit(5);if(error)throw error;
    for(const job of due||[]){
      const claimed=await supabase.from('wryte_scheduled_posts').update({status:'processing',updated_at:new Date().toISOString()}).eq('id',job.id).eq('status','pending').select('id').maybeSingle();if(claimed.error||!claimed.data)continue;
      try{
        if(!job.project||!job.project.title||!job.project.body)throw new Error('Scheduled article content is missing or expired.');
        const results=await publishProject(job.user_id,job.project,job.destinations||{},job.site_ids||{},false);
        const requested=job.destinations?.blogger?1:0;
        const publishResults=results.filter(r=>r.destination==='Blogger');
        const allSucceeded=requested>0&&publishResults.length>=requested&&publishResults.every(r=>r.status==='success');
        const completedAt=new Date().toISOString();
        const update={status:allSucceeded?'published':'failed',results,error_message:allSucceeded?null:results.map(r=>r.status==='failed'?`${r.destination}: ${r.message}`:null).filter(Boolean).join('; ')||'One or more destinations did not confirm delivery.',completed_at:completedAt,updated_at:completedAt};
        if(allSucceeded){update.project=null;update.content_purged_at=completedAt;}
        const {error:updateError}=await supabase.from('wryte_scheduled_posts').update(update).eq('id',job.id).eq('status','processing');if(updateError)throw updateError;if(allSucceeded)sendPushToUser(job.user_id,{title:'Scheduled post delivered',body:`“${String(job.project?.title||'Your article').slice(0,100)}” was published successfully.`,type:'scheduled_post_delivered',projectId:job.project_id});
      }
      catch(e){await supabase.from('wryte_scheduled_posts').update({status:'failed',error_message:String(e.message||'Scheduled publish failed').slice(0,1000),completed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',job.id).eq('status','processing');}
    }
  }catch(e){console.error('Scheduled publish worker:',e.message);}finally{scheduleWorkerRunning=false;}
}
setInterval(processScheduledPosts,15_000).unref?.();
app.post('/api/internal/scheduled-worker',async(req,res)=>{const secret=String(process.env.SCHEDULE_WORKER_SECRET||'');const supplied=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!secret||!safeEqual(supplied,secret))return res.status(401).json({error:'Unauthorized'});processScheduledPosts().catch(()=>{});res.json({ok:true,queued:'worker triggered'});});

// AI costs are estimated from observed tokens and current rate configuration. Credits are internal units;
// a wallet RPC atomically spends credits or consumes one of the two initial-article entitlements.
// ---- Cost-based pricing: credits are derived from real OpenAI costs, so changing model/prices never silently loses money ----
// Hard-coded pricing and usage protections. Update these constants in source when pricing changes.
const envNum=(k,d)=>{const v=Number(process.env[k]);return Number.isFinite(v)&&v>0?v:d;};
const PRICING_CONFIG = Object.freeze({
  inputUsdPerMillion: 0.40,
  outputUsdPerMillion: 1.60,
  imageUsdCost: 0.063,
  creditMarkup: 5,
  creditValueUsd: 0.002,
  maxSearchCalls: 3,
  trialFollowupLimit: 4,
  maxInputTokensEstimate: 35000
});
function pricing(){const inPerM=PRICING_CONFIG.inputUsdPerMillion;return {inPerM,outPerM:PRICING_CONFIG.outputUsdPerMillion,
  search:0.01+8000*inPerM/1e6, // estimated web search cost per call
  image:PRICING_CONFIG.imageUsdCost,
  markup:PRICING_CONFIG.creditMarkup,
  creditUsd:PRICING_CONFIG.creditValueUsd};
}
const costUsd=({input=0,output=0,searches=0})=>{const p=pricing();return input/1e6*p.inPerM+output/1e6*p.outPerM+searches*p.search;};
const creditsForUsd=(usd)=>{const p=pricing();return Math.max(1,Math.ceil(usd*p.markup/p.creditUsd));};
const imageCredits=()=>Number(process.env.IMAGE_CREDIT_COST)||creditsForUsd(pricing().image);
const MAX_SEARCH_CALLS=()=>PRICING_CONFIG.maxSearchCalls;
const maxOutTokens=(action)=>action==='diagnose'?1500:Math.min(12000,envNum('MAX_OUTPUT_TOKENS',9000));
const searchLimit=(action)=>action==='diagnose'||process.env.ENABLE_WEB_SEARCH==='false'?0:(action==='initial'?MAX_SEARCH_CALLS():Math.min(2,MAX_SEARCH_CALLS()));
// The hold is the worst case the request can cost (token caps + search cap), so a generation can never cost more than was reserved.
function estimateCredits({action,brief={}}){if(action==='image')return imageCredits();// Reserve against a conservative input allowance plus the hard output/search caps. Settlement refunds unused units.
const inputGuess=PRICING_CONFIG.maxInputTokensEstimate;return creditsForUsd(costUsd({input:inputGuess,output:maxOutTokens(action),searches:searchLimit(action)}));}
async function debitBefore(uid,{action,projectId,brief}){const units=estimateCredits({action,brief});const {data,error}=await supabase.rpc('wryte_reserve_usage',{p_user_id:uid,p_action:action,p_project_id:projectId||null,p_estimated_credits:units});if(error)throw new Error('Credit service unavailable. Try again later.');if(!data?.ok) {const e=new Error(data?.error||'Not enough credits. Purchase a credit pack to continue.');e.status=402;throw e;}return {reservationId:data.reservation_id,units:data.reserved_credits||0,free:data.free||false};}
async function settleUsage(reservationId,uid,usage,action,projectId){const actual=creditsForUsd(costUsd({input:Number(usage?.inputTokens||0),output:Number(usage?.outputTokens||0),searches:Number(usage?.searchCalls||0)}));const {data,error}=await supabase.rpc('wryte_settle_usage',{p_reservation_id:reservationId,p_user_id:uid,p_actual_credits:actual,p_usage:usage||{},p_action:action,p_project_id:projectId||null});if(error||data?.ok===false)throw new Error('Could not settle usage. Contact support before retrying.');return data;}
app.get('/api/credits',auth,dbRequired,async(req,res)=>{try{const w=await ensureWallet(req.user.uid);res.json({credits:w.credits||0,freeGenerationsRemaining:Math.max(0,2-(w.free_generations_used||0)),unit:'credits'});}catch(e){res.status(500).json({error:'Unable to load credit balance.'});}});
app.post('/api/generate',auth,dbRequired,async(req,res)=>{
  let reservation=null;const {action='initial',project,brief={},instruction='',projectId,documentType='article'}=req.body||{};
  try{
    if(!OPENAI_API_KEY)return res.status(503).json({error:'AI service is not configured. Add OPENAI_API_KEY to the server environment.'});
    if(!['initial','document','revision','fix','diagnose'].includes(action))return res.status(400).json({error:'Unsupported AI action.'});
    if(action==='document'&&!['letter','email','resume','coverLetter','proposal','report','businessPlan','meetingMinutes','socialPost','productDescription','pressRelease'].includes(documentType))return res.status(400).json({error:'Choose a supported document type.'});
    const briefSize=Buffer.byteLength(JSON.stringify(brief||{}),'utf8');
    const existingBody=String(project?.body||'');
    if(briefSize>30000||String(instruction||'').length>8000||existingBody.length>80000)return res.status(413).json({error:'This request is too large to process safely. Shorten the form details or draft and try again.'});
    if(['initial','document'].includes(action)&&(!String(brief.title||'').trim()||String(brief.style||'').trim().length<8||(action==='initial'&&!String(brief.niche||'').trim())))return res.status(400).json({error:'Add a clear title or purpose and at least 8 characters of detailed instructions.'});
    const wallet=await ensureWallet(req.user.uid);const targetProject=projectId||project?.id||crypto.randomUUID();
    // Free trial follow-ups are reserved atomically in PostgreSQL. A failed request releases the slot.
    const trialIds=wallet.trial_project_ids||[];const trialProject=trialIds.includes(targetProject);
    if(action!=='initial'&&action!=='document'&&trialProject){
      const {data:trial,error:trialError}=await supabase.rpc('wryte_reserve_trial_followup',{p_user_id:req.user.uid,p_project_id:targetProject,p_action:action,p_limit:PRICING_CONFIG.trialFollowupLimit});
      if(trialError)throw new Error('Credit service unavailable. Try again later.');
      if(trial?.ok)reservation={free:true,reservationId:trial.reservation_id,units:0};
      else reservation=await debitBefore(req.user.uid,{action,projectId:targetProject,brief});
    } else reservation=await debitBefore(req.user.uid,{action,projectId:targetProject,brief});
    const existing=project?.body||'';const isDiagnosis=action==='diagnose';
    const system=`You are Wyticle AI, an expert human-centered writer, researcher and editor. Produce specific, deeply useful, naturally human-sounding work that faithfully follows the user's requested tone and format. Avoid formulaic AI transitions, filler, repetition, robotic phrasing, fake personal anecdotes, invented facts, fake quotations and fabricated citations. Use web search for factual or current claims when useful; only cite sources actually returned by research. Respect niche-specific risk and never present medical, legal or financial content as personalized professional advice. Apply E-E-A-T through transparent, accurate, well-supported information and first-hand context only when supplied; never fabricate experience, credentials or expertise. Output only valid JSON matching the schema.`;
    const diagnosisSchema={type:'object',properties:{diagnosis:{type:'object',properties:{score:{type:'integer'},findings:{type:'array',items:{type:'string'}}},required:['score','findings'],additionalProperties:false}},required:['diagnosis'],additionalProperties:false};
    const articleSchema={type:'object',properties:{title:{type:'string'},html:{type:'string'},plainText:{type:'string'},seo:{type:'object',properties:{title:{type:'string'},description:{type:'string'},slug:{type:'string'},primaryKeyword:{type:'string'},relatedKeywords:{type:'array',items:{type:'string'}},wordCount:{type:'integer'},readability:{type:'string'}},required:['title','description','slug','primaryKeyword','relatedKeywords','wordCount','readability'],additionalProperties:false},sources:{type:'array',items:{type:'object',properties:{title:{type:'string'},url:{type:'string'},publisher:{type:'string'},supports:{type:'string'}},required:['title','url','publisher','supports'],additionalProperties:false}}},required:['title','html','plainText','seo','sources'],additionalProperties:false};
    const docRules={letter:'Use a standard letter layout where applicable: date, sender/return address if provided, recipient name and address if provided, salutation, clear paragraphs, courteous closing, and sender name. Do not invent addresses or facts.',email:'Use a concise subject/title, appropriate greeting, readable body, clear call to action when useful, sign-off and sender details if supplied. Avoid fake email addresses.',resume:'Create a professional ATS-friendly CV/resume with contact details only if supplied, professional summary, skills, experience, education and certifications as applicable. Never invent employers, qualifications, dates, metrics or contact information; use clear placeholders for missing essential details.',coverLetter:'Create a tailored cover letter with date and recipient details if supplied, role/company, relevant evidence from the user-provided experience, a professional opening, specific fit, and closing. Never invent experience.',proposal:'Use an executive summary, problem/opportunity, objectives, scope, approach, timeline, deliverables, budget only if provided, risks and next steps as applicable.',report:'Use a clear title, executive summary, background, methodology only if supplied, findings, analysis, recommendations and conclusion. Separate facts from assumptions.',businessPlan:'Use executive summary, business description, customer problem, offering, market and competitor analysis with uncertainty stated, marketing and operations, team, risks, and financial assumptions only where supplied. Do not fabricate verified market statistics.',meetingMinutes:'Use meeting title, date, attendees, agenda, discussion summary, decisions, action items with owners and deadlines only if supplied, and next meeting if known.',socialPost:'Create platform-appropriate content with a strong opening, concise body, suitable call to action and optional relevant hashtags. Avoid unsupported claims and platform policy violations.',productDescription:'Write a clear product title, customer benefits, features, use cases, specifications only if supplied, limitations and a truthful call to action. Never invent product certifications or performance claims.',pressRelease:'Use a standard press release structure: FOR IMMEDIATE RELEASE only if appropriate, headline, subheadline if useful, dateline only if supplied, lead paragraph, supporting facts, approved quote only if supplied (otherwise no fake quote), company boilerplate only from supplied facts, and media contact only if supplied.'};
    const isDocument=action==='document'||(brief.documentType&&brief.documentType!=='article');
    const docType=brief.documentType||documentType||'article';
    const userTask=isDiagnosis?`Perform a professional quality audit of this ${docType==='article'?'article':docType} and return only a realistic score from 0-100 plus concise, prioritized, actionable findings. Evaluate whether it fulfills the user's brief and intended outcome; completeness of required information; factual reliability and unsupported claims; correct genre-specific conventions and layout; clarity, tone, audience fit, structure, readability, grammar, consistency, accessibility and practical usability. For articles also assess search intent, SEO title/meta/heading structure, keyword naturalness and source support. For letters/emails assess sender/recipient context, salutation, tone, clear ask and closing. For resumes assess ATS readability, evidence-backed achievements, consistency and missing factual details without inventing credentials. For proposals/business plans assess scope, deliverables, timeline, assumptions, risks and feasibility. For reports assess scope, evidence, findings and recommendations. For minutes assess decisions, action owners and deadlines. For social/product/press content assess platform fit, truthful claims and required brand/announcement facts. Do not rewrite yet. Title: ${project?.title||brief.title}; brief: ${JSON.stringify(brief)}; existing HTML: ${existing}`:`Action: ${action}. Output type: ${isDocument?docType:'article'}. Title/purpose: ${brief.title||project?.title||''}. Requested style and instructions: ${brief.style||''}. Recipient: ${brief.recipient||'not supplied'}. Sender: ${brief.sender||'not supplied'}. Organization: ${brief.organization||'not supplied'}. Date: ${brief.date||'not supplied'}. Audience / target role: ${brief.audience||'infer only when safe'}. Country: ${brief.country||'not specified'}. Niche: ${brief.niche||project?.niche||'not applicable'}. Length: ${brief.length||'appropriate for this document type'}. Additional information: ${brief.additional||'None'}. Purpose and key requirements: ${brief.purpose||'As described by the user'}. Requested changes: ${instruction||'None'}. Existing content: ${existing||'(new project)'}. ${isDocument?(docRules[docType]||'Use the standard professional structure for this document type.'):'Detect primary and related keywords automatically. Use a strong H1 first, useful introduction, detailed body sections and conclusion. Return semantic article HTML only, not a full document. Keep SEO outside article body.'} Never invent facts, addresses, qualifications, quotes, names, sources or URLs. Use clear placeholders for important missing details instead of guessing. Produce clean semantic HTML with meaningful headings, paragraphs, lists and spacing. Preserve good content during revisions and fixes.`;
    const body={model:OPENAI_MODEL,input:[{role:'system',content:system},{role:'user',content:userTask}],text:{format:{type:'json_schema',name:isDiagnosis?'article_diagnosis':'article_result',strict:true,schema:isDiagnosis?diagnosisSchema:articleSchema}},max_output_tokens:maxOutTokens(action)};
    if(searchLimit(action)>0){body.tools=[{type:'web_search'}];body.max_tool_calls=searchLimit(action);}
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const data=await r.json();if(!r.ok)throw new Error(data.error?.message||'AI provider request failed');
    if(data.status==='incomplete')throw new Error('The response was too long and was cut off. Choose a shorter length or fewer sections and try again. You were not charged.');
    const outputText=(data.output||[]).flatMap(item=>item.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('\n');if(!outputText){const refused=(data.output||[]).flatMap(item=>item.content||[]).some(c=>c.type==='refusal');throw new Error(refused?'The AI declined this request. Adjust the topic or instructions and try again.':'The AI returned no content. Please retry.');}let parsed;try{parsed=JSON.parse(outputText)}catch{throw new Error('The AI response could not be parsed. Please retry.');}
    const usage={inputTokens:data.usage?.input_tokens||0,outputTokens:data.usage?.output_tokens||0,searchCalls:(data.output||[]).filter(x=>x.type==='web_search_call').length,model:OPENAI_MODEL};parsed.usage=usage;
    if(reservation?.reservationId)await settleUsage(reservation.reservationId,req.user.uid,usage,action,targetProject);
    else if(reservation?.free&&action==='initial') {const {error}=await supabase.rpc('wryte_register_trial_project',{p_user_id:req.user.uid,p_project_id:targetProject});if(error)throw new Error('Could not save free article entitlement. Please contact support.');}
    const updated=await ensureWallet(req.user.uid);parsed.billing={credits:updated.credits||0,freeGenerationsRemaining:Math.max(0,2-(updated.free_generations_used||0)),chargedCredits:reservation?.free?0:undefined,projectId:targetProject};parsed.documentType=docType;sendPushToUser(req.user.uid,{title:isDiagnosis?'Your content check is ready':'Your content is ready',body:isDiagnosis?'Wyticle AI finished checking your content.':'Wyticle AI finished generating your content.',type:'generation_complete',projectId:targetProject});res.json(parsed);
  }catch(e){if(reservation?.reservationId){try{await supabase.rpc('wryte_release_usage',{p_reservation_id:reservation.reservationId,p_user_id:req.user.uid});}catch{}}console.error('Generate:',e.message);res.status(e.status||500).json({error:e.status===402?e.message:(e.message||'Unexpected generation error. Please retry.')});}
});

app.post('/api/image',auth,dbRequired,async(req,res)=>{
  let reservation=null;
  try{
    if(!OPENAI_API_KEY)return res.status(503).json({error:'Image generation is not configured.'});
    const {projectId,title,niche,style,details=''}=req.body||{};if(!projectId||!title)return res.status(400).json({error:'Article project and title are required.'});
    await ensureWallet(req.user.uid);
    // Image generation is a separately priced premium operation to protect margins; users can still upload their own image for free.
    reservation=await debitBefore(req.user.uid,{action:'image',projectId,brief:{length:'image'}});
    const prompt=`Create a polished, original editorial featured image for a blog article. Topic: ${String(title).slice(0,500)}. Niche: ${String(niche||'general').slice(0,120)}. Visual style requested: ${String(style||'professional, clear, modern').slice(0,300)}. Additional context: ${String(details).slice(0,500)}. Composition should be high quality, readable at blog thumbnail size, with no text, no logos, no watermarks, no fake brand marks. Do not create misleading depictions for medical, financial, political, or news claims.`;
    const r=await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_IMAGE_MODEL||'gpt-image-1',prompt,size:'1536x1024',quality:'medium',n:1,output_format:'jpeg'}),signal:AbortSignal.timeout(120000)});const data=await r.json();if(!r.ok)throw new Error(data.error?.message||'Image generation failed.');const b64=data.data?.[0]?.b64_json;if(!b64)throw new Error('Image service returned no image.');
    if(reservation?.reservationId){const cost=imageCredits();const {error}=await supabase.rpc('wryte_settle_usage',{p_reservation_id:reservation.reservationId,p_user_id:req.user.uid,p_actual_credits:cost,p_usage:{imageModel:process.env.OPENAI_IMAGE_MODEL||'gpt-image-1'},p_action:'image',p_project_id:projectId});if(error)throw new Error('Could not settle image usage.');}
    const updated=await ensureWallet(req.user.uid);res.json({dataUrl:`data:image/jpeg;base64,${b64}`,credits:updated.credits||0,freeGenerationsRemaining:Math.max(0,2-(updated.free_generations_used||0))});
  }catch(e){if(reservation?.reservationId){try{await supabase.rpc('wryte_release_usage',{p_reservation_id:reservation.reservationId,p_user_id:req.user.uid});}catch{}}console.error('Image generation:',e.message);res.status(e.status||500).json({error:e.message||'Image generation failed.'});}
});

// Flutterwave v4 card flow (NGN). It deliberately does not call v3 endpoints.
// Packs are priced in USD; the NGN amount actually charged is derived from USD_NGN_RATE (update it when the exchange rate moves).
const packDefs={starter:{id:'starter',label:'Starter',usd:4,bonus:0},creator:{id:'creator',label:'Creator',usd:9,bonus:0.08},studio:{id:'studio',label:'Studio',usd:18,bonus:0.15}};
const packs=Object.fromEntries(Object.entries(packDefs).map(([k,d])=>[k,{...d,get credits(){return Math.round(d.usd/pricing().creditUsd*(1+d.bonus)/10)*10;}}]));
const usdNgnRate=()=>Math.max(1,Number(process.env.USD_NGN_RATE||1500));
const packNGN=p=>Math.ceil(p.usd*usdNgnRate()/10)*10;
const FLW_BASE=()=>String(process.env.FLW_V4_BASE_URL||'https://developersandbox-api.flutterwave.com').replace(/\/$/,'');
let flwTokenCache={token:'',expiresAt:0};
async function getFlutterwaveAccessToken(){if(flwTokenCache.token&&flwTokenCache.expiresAt>Date.now()+30_000)return flwTokenCache.token;const missing=requiredEnv(['FLW_V4_CLIENT_ID','FLW_V4_CLIENT_SECRET']);if(missing.length)throw new Error(`Flutterwave v4 credentials missing: ${missing.join(', ')}`);const r=await fetch('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.FLW_V4_CLIENT_ID,client_secret:process.env.FLW_V4_CLIENT_SECRET,grant_type:'client_credentials'}),signal:AbortSignal.timeout(10000)});const d=await r.json();if(!r.ok||!d.access_token)throw new Error('Flutterwave v4 authentication failed. Check Client ID and Client Secret.');flwTokenCache={token:d.access_token,expiresAt:Date.now()+Math.max(60,Number(d.expires_in||600))*1000};return flwTokenCache.token;}
app.get('/api/billing/packs',auth,(_req,res)=>res.json({packs:Object.values(packs).map(p=>({id:p.id,label:p.label,usd:p.usd,amountNGN:packNGN(p),credits:p.credits,currency:'NGN'})),rate:usdNgnRate(),paymentMethod:'Card',note:'Charged in naira at the displayed rate.'}));
app.get('/api/billing/return',(req,res)=>{const ref=String(req.query.payment_ref||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);const to=String(req.query.to||'');const q=`payment_ref=${encodeURIComponent(ref)}`;if(to==='app')return res.redirect(`ai.wryte.app://auth-callback?${q}`);res.redirect(`${APP_URL}/?${q}`);});

// ---- Flutterwave v4 card flow: customer -> encrypted payment method -> charge -> PIN -> OTP (or 3-D Secure redirect) -> verify ----
const billingLimiter=rateLimit({windowMs:15*60_000,limit:20,standardHeaders:true,legacyHeaders:false,keyGenerator:req=>req.user?.uid||'anon',message:{error:'Too many payment attempts. Please wait a few minutes.'}});
const billingVerifyLimiter=rateLimit({windowMs:15*60_000,limit:60,standardHeaders:true,legacyHeaders:false,keyGenerator:req=>req.user?.uid||'anon',message:{error:'Too many verification attempts. Wait a few minutes before checking again.'}});
function flwNonce(){const c='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';return Array.from(crypto.randomBytes(12),b=>c[b%c.length]).join('');}
// AES-256-GCM as required by Flutterwave v4: base64 key from the dashboard, 12-character nonce, output = base64(ciphertext || auth tag).
function flwEncrypt(plain,nonce){const key=Buffer.from(process.env.FLW_V4_ENCRYPTION_KEY||'','base64');if(key.length!==32)throw new Error('FLW_V4_ENCRYPTION_KEY must be the 32-byte base64 encryption key from the Flutterwave dashboard.');const cipher=crypto.createCipheriv('aes-256-gcm',key,Buffer.from(nonce,'utf8'));const enc=Buffer.concat([cipher.update(String(plain),'utf8'),cipher.final()]);return Buffer.concat([enc,cipher.getAuthTag()]).toString('base64');}
function stableIdempotencyKey(seed){const h=crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0,32);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
async function flw(method,path,body,idempotencySeed=null){const token=await getFlutterwaveAccessToken();const r=await fetch(`${FLW_BASE()}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Trace-Id':crypto.randomUUID(),'X-Idempotency-Key':stableIdempotencyKey(idempotencySeed||`${method}:${path}:${crypto.randomUUID()}`)},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});const data=await r.json().catch(()=>({}));if(!r.ok||data.status==='failed'||data.status==='error'){const msg=data.error?.validation_errors?.[0]?.message||data.error?.message||data.message||`Flutterwave request failed (${r.status})`;const e=new Error(msg);e.status=r.status;throw e;}return data.data??data;}
function luhnOk(n){let sum=0,alt=false;for(let i=n.length-1;i>=0;i--){let d=Number(n[i]);if(alt){d*=2;if(d>9)d-=9;}sum+=d;alt=!alt;}return sum%10===0;}
// Translate a v4 charge into the next step the app must show.
function chargeState(charge){const na=charge?.next_action||{};const status=String(charge?.status||'pending').toLowerCase();
  if(status==='succeeded')return {step:'done'};
  if(['failed','voided','cancelled'].includes(status))return {step:'failed',message:charge?.processor_response?.message||'The payment was declined.'};
  if(na.type==='requires_pin')return {step:'pin',message:'Enter your 4-digit card PIN.'};
  if(na.type==='requires_otp')return {step:'otp',message:na.requires_otp?.message||na.message||'Enter the OTP your bank sent you.'};
  if(na.type==='redirect_url'){const url=na.redirect_url?.url||(typeof na.redirect_url==='string'?na.redirect_url:'');return url?{step:'redirect',url}:{step:'wait'};}
  if(na.type==='requires_additional_fields')return {step:'failed',message:'This card needs extra verification that is not supported yet. Try another card.'};
  return {step:'wait',message:na.payment_instruction?.note||null};
}
app.post('/api/billing/checkout',auth,dbRequired,billingLimiter,async(req,res)=>{
  const missing=requiredEnv(['FLW_V4_CLIENT_ID','FLW_V4_CLIENT_SECRET','FLW_V4_BASE_URL','FLW_V4_ENCRYPTION_KEY']);if(missing.length)return res.status(503).json({error:`Flutterwave v4 is not configured: ${missing.join(', ')}`});
  const pack=packs[String(req.body?.packId||'')];if(!pack)return res.status(400).json({error:'Choose a valid credit pack.'});
  if(!req.user.email)return res.status(400).json({error:'Your Google account must have an email address to purchase credits.'});
  const c=req.body?.card||{};const number=String(c.number||'').replace(/\D/g,'');const month=String(c.expiryMonth||'').replace(/\D/g,'').padStart(2,'0');let year=String(c.expiryYear||'').replace(/\D/g,'');if(year.length===4)year=year.slice(2);const cvv=String(c.cvv||'').replace(/\D/g,'');
  if(number.length<12||number.length>19||!luhnOk(number))return res.status(400).json({error:'Check your card number.'});
  if(!/^(0[1-9]|1[0-2])$/.test(month)||year.length!==2)return res.status(400).json({error:'Enter a valid expiry date (MM/YY).'});
  const nowD=new Date();if(Number('20'+year)*12+Number(month)<nowD.getFullYear()*12+nowD.getMonth()+1)return res.status(400).json({error:'This card has expired.'});
  if(cvv.length<3||cvv.length>4)return res.status(400).json({error:'Check your card security code.'});
  let returnUrl=APP_URL;try{const requested=new URL(req.body?.returnUrl||APP_URL);if(requested.origin===APP_URL||requested.protocol==='ai.wryte.app:')returnUrl=requested.toString();}catch{}
  const amountNGN=packNGN(pack);const reference=`wryte${crypto.randomUUID().replace(/-/g,'')}`.slice(0,40);let chargeCreated=false,chargeAttempted=false;
  const ambiguousFailure=e=>!e.status||e.status>=500||e.status===409; // timeout / network / 5xx / duplicate-key: the charge may exist at the provider
  try{await ensureWallet(req.user.uid);}catch(e){console.error('Checkout wallet:',e.message);return res.status(500).json({error:'Could not load your account. Try again.'});} // payments.user_id references the wallet row
  const {error:insertError}=await supabase.from('wryte_payments').insert({user_id:req.user.uid,provider:'flutterwave-v4',reference,amount:amountNGN,currency:'NGN',credits:pack.credits,status:'pending'});if(insertError)return res.status(500).json({error:'Could not create payment record. Try again.'});
  try{
    const wallet=await ensureWallet(req.user.uid);let customerId=wallet.flw_customer_id||'';
    if(!customerId){const parts=String(req.user.name||'Wyticle User').trim().split(/\s+/);const first=parts.shift()||'Wyticle';const last=parts.join(' ')||'User';const phone=String(req.body?.phone||'').replace(/\D/g,'').replace(/^0/,'');
      const cust=await flw('POST','/customers',{email:req.user.email,name:{first,last},...(phone.length>=7&&phone.length<=12?{phone:{country_code:'234',number:phone}}:{})});customerId=cust.id;
      await supabase.from('wryte_wallets').update({flw_customer_id:customerId}).eq('user_id',req.user.uid);}
    const nonce=flwNonce();
    const pm=await flw('POST','/payment-methods',{type:'card',card:{encrypted_card_number:flwEncrypt(number,nonce),encrypted_expiry_month:flwEncrypt(month,nonce),encrypted_expiry_year:flwEncrypt(year,nonce),encrypted_cvv:flwEncrypt(cvv,nonce),nonce}});
    const redirect_url=returnUrl.startsWith('ai.wryte.app:')?`${API_PUBLIC_URL}/api/billing/return?to=app&payment_ref=${encodeURIComponent(reference)}`:`${returnUrl}${returnUrl.includes('?')?'&':'?'}payment_ref=${encodeURIComponent(reference)}`;
    const chargeBody={reference,currency:'NGN',amount:amountNGN,customer_id:customerId,payment_method_id:pm.id,redirect_url,meta:{user_id:req.user.uid,pack_id:pack.id,credits:pack.credits,usd:pack.usd,rate:usdNgnRate()}};chargeAttempted=true;
    let charge;try{charge=await flw('POST','/charges',chargeBody,`charge:${reference}`);}catch(first){if(!ambiguousFailure(first))throw first;charge=await flw('POST','/charges',chargeBody,`charge:${reference}`);} // one safe retry: the idempotency key is stable, so it cannot double-charge
    chargeCreated=true;
    const {error:saveChargeError}=await supabase.from('wryte_payments').update({provider_transaction_id:String(charge.id),verified_payload:{next_action:charge.next_action?.type||null,usd:pack.usd,rate:usdNgnRate()}}).eq('reference',reference).eq('user_id',req.user.uid);if(saveChargeError)throw new Error('Payment started, but its verification record could not be saved yet.');
    const state=chargeState(charge);if(state.step==='failed')await supabase.from('wryte_payments').update({status:'failed'}).eq('reference',reference).eq('user_id',req.user.uid);
    res.json({reference,state,credits:pack.credits,usd:pack.usd,amountNGN,currency:'NGN'});
  }catch(e){console.error('Flutterwave v4 checkout:',e.message);if(chargeCreated||(chargeAttempted&&ambiguousFailure(e))){res.status(202).json({reference,state:{step:'wait',message:'Payment may have started. Wyticle is keeping the reference so it can safely verify the result; do not pay again yet.'},credits:pack.credits,amountNGN,currency:'NGN'});return;}await supabase.from('wryte_payments').update({status:'failed'}).eq('reference',reference).eq('user_id',req.user.uid);res.status(502).json({error:e.message||'Could not start checkout. No credits were charged.'});}
});
// Submit the card PIN or the bank OTP for a pending charge.
app.post('/api/billing/authorize',auth,dbRequired,billingLimiter,async(req,res)=>{
  const reference=String(req.body?.reference||'');const type=String(req.body?.type||'');
  const {data:payment,error}=await supabase.from('wryte_payments').select('*').eq('reference',reference).eq('user_id',req.user.uid).maybeSingle();
  if(error||!payment)return res.status(404).json({error:'Payment reference not found for this account.'});
  if(payment.status!=='pending'||!payment.provider_transaction_id)return res.status(409).json({error:'This payment can no longer be authorized. Start a new purchase.'});
  try{
    let authorization;
    if(type==='pin'){const pin=String(req.body?.pin||'').replace(/\D/g,'');if(pin.length!==4)return res.status(400).json({error:'Enter your 4-digit card PIN.'});const nonce=flwNonce();authorization={type:'pin',pin:{encrypted_pin:flwEncrypt(pin,nonce),nonce}};}
    else if(type==='otp'){const code=String(req.body?.otp||'').replace(/\D/g,'');if(code.length<4||code.length>10)return res.status(400).json({error:'Enter the OTP from your bank.'});authorization={type:'otp',otp:{code}};}
    else return res.status(400).json({error:'Unsupported authorization type.'});
    const charge=await flw('PUT',`/charges/${encodeURIComponent(payment.provider_transaction_id)}`,{authorization},`authorize:${reference}:${type}:${crypto.createHash('sha256').update(String(type==='pin'?req.body?.pin:req.body?.otp||'')).digest('hex').slice(0,12)}`);
    const state=chargeState(charge);if(state.step==='failed')await supabase.from('wryte_payments').update({status:'failed'}).eq('reference',reference).eq('user_id',req.user.uid);
    res.json({reference,state});
  }catch(e){console.error('Flutterwave v4 authorize:',e.message);res.status(502).json({error:e.message||'The bank could not authorize this payment. Check the details and try again.'});}
});
// Retrieve the charge from Flutterwave and credit the wallet exactly once if it truly succeeded for the right amount.
async function verifyAndCredit(payment){
  if(payment.status==='succeeded'){const w=await ensureWallet(payment.user_id);return {code:200,body:{ok:true,status:'succeeded',credits:w.credits,addedCredits:0,duplicate:true,message:'This payment was already credited.'}};}
  if(!payment.provider_transaction_id)return {code:202,body:{ok:false,status:payment.status,message:'Payment is still being initialized. Try again shortly.'}};
  const tx=await flw('GET',`/charges/${encodeURIComponent(payment.provider_transaction_id)}`);
  const status=tx.status==='succeeded'?'succeeded':['failed','voided','cancelled'].includes(tx.status)?'failed':'pending';
  if(status==='succeeded'){
    if(String(tx.reference)!==payment.reference||String(tx.currency).toUpperCase()!==String(payment.currency).toUpperCase()||!Number.isFinite(Number(tx.amount))||Number(tx.amount)!==Number(payment.amount)||String(tx.id)!==String(payment.provider_transaction_id))return {code:409,body:{error:'Payment verification details do not match exactly. Credits were not added.'}};
    const {data:result,error:creditError}=await supabase.rpc('wryte_credit_payment',{p_user_id:payment.user_id,p_reference:payment.reference,p_credits:payment.credits,p_transaction_id:String(tx.id),p_verified_payload:tx});if(creditError)throw creditError;
    const w=await ensureWallet(payment.user_id);return {code:200,body:{ok:true,status:'succeeded',credits:w.credits,addedCredits:result?.duplicate?0:payment.credits,duplicate:Boolean(result?.duplicate)}};
  }
  if(status==='failed')await supabase.from('wryte_payments').update({status:'failed',verified_payload:tx}).eq('reference',payment.reference).eq('user_id',payment.user_id);
  return {code:202,body:{ok:false,status,state:chargeState(tx),message:status==='pending'?'Payment is still pending. Try again shortly.':(tx.processor_response?.message||'Payment failed. You can try again.')}};
}
app.post('/api/billing/verify',auth,dbRequired,billingVerifyLimiter,async(req,res)=>{
  const reference=String(req.body?.reference||'');if(!reference)return res.status(400).json({error:'Payment reference is required.'});
  const {data:payment,error}=await supabase.from('wryte_payments').select('*').eq('reference',reference).eq('user_id',req.user.uid).maybeSingle();if(error||!payment)return res.status(404).json({error:'Payment reference not found for this account.'});
  if(!/^[a-zA-Z0-9_-]{8,80}$/.test(reference))return res.status(400).json({error:'Payment reference format is invalid.'});
  try{const out=await verifyAndCredit(payment);res.status(out.code).json(out.body);}catch(e){console.error('Flutterwave v4 verification:',e.message);res.status(502).json({error:'Could not verify the payment yet. No credits were added; try again.'});}
});
// Optional webhook so credits arrive even if the app is closed mid-payment. Set the same secret hash in the Flutterwave dashboard.
app.post('/api/billing/webhook',async(req,res)=>{
  const secret=process.env.FLW_V4_WEBHOOK_SECRET_HASH;if(!secret||!supabase||!req.rawBody)return res.status(404).end();
  const sig=String(req.headers['flutterwave-signature']||'');const expected=crypto.createHmac('sha256',secret).update(req.rawBody).digest('base64');
  if(!sig||!safeEqual(sig,expected))return res.status(401).end();
  res.status(200).json({received:true});
  try{
    const eventData=req.body?.data||{};const chargeId=eventData.id;if(!chargeId)return;
    let {data:payment}=await supabase.from('wryte_payments').select('*').eq('provider_transaction_id',String(chargeId)).eq('provider','flutterwave-v4').maybeSingle();
    // Recover a rare case where Flutterwave created a charge but the API timed out before saving its ID.
    if(!payment&&eventData.reference){
      const {data:candidate}=await supabase.from('wryte_payments').select('*').eq('reference',String(eventData.reference)).eq('provider','flutterwave-v4').eq('status','pending').maybeSingle();
      if(candidate){await supabase.from('wryte_payments').update({provider_transaction_id:String(chargeId)}).eq('id',candidate.id).eq('status','pending');const fresh=await supabase.from('wryte_payments').select('*').eq('id',candidate.id).maybeSingle();payment=fresh.data;}
    }
    if(payment)await verifyAndCredit(payment);
  }catch(e){console.error('Flutterwave webhook:',e.message);}
});

// Consistent JSON errors (CORS rejections and malformed JSON used to return HTML error pages).
app.use((err,_req,res,_next)=>{
  if(err?.message==='Origin not allowed')return res.status(403).json({error:'This origin is not allowed. Add it to ALLOWED_ORIGIN.'});
  if(err?.type==='entity.parse.failed')return res.status(400).json({error:'Invalid JSON request.'});
  if(err?.type==='entity.too.large')return res.status(413).json({error:'Request is too large.'});
  console.error('Unhandled error:',err?.message||err);res.status(err?.status||500).json({error:'Unexpected server error.'});
});
process.on('unhandledRejection',e=>console.error('Unhandled rejection:',e?.message||e));
{const need=['FIREBASE_SERVICE_ACCOUNT_JSON|GOOGLE_APPLICATION_CREDENTIALS','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','TOKEN_ENCRYPTION_KEY','OPENAI_API_KEY','GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET','APP_URL','API_PUBLIC_URL','ALLOWED_ORIGIN'];
const missing=need.filter(n=>!n.split('|').some(k=>process.env[k]));if(missing.length)console.warn('[config] Missing environment variables:',missing.join(', '));
if(process.env.TOKEN_ENCRYPTION_KEY&&Buffer.from(process.env.TOKEN_ENCRYPTION_KEY,'base64').length!==32)console.warn('[config] TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.');
if(process.env.NODE_ENV==='production'&&!allowedOrigins.length)console.warn('[config] ALLOWED_ORIGIN is empty: browser requests will be rejected in production.');}
app.listen(port,()=>console.log(`Wyticle AI API listening on ${port}`));
